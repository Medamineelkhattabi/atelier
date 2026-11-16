"""Named secrets: encrypted at rest, never returned in plaintext through the API.

A secret is global (project_id "") or belongs to one project. A run sees global
secrets plus its own project's secrets, never another project's; a project secret
with the same name as a global one takes precedence inside that project.
"""

from __future__ import annotations

import os
import re

from pae.db import AuditEntry, Database, Secret
from pae.security import Redactor, SecretBox, secret_hint
from pae.subscription import FORBIDDEN_SECRET, SUBSCRIPTION_ENV

NAME = re.compile(r"^[A-Z][A-Z0-9_]{1,99}$")
GLOBAL = ""


def _scope(project_id: str | None) -> str:
    return project_id or GLOBAL


class SecretsService:
    def __init__(self, db: Database, box: SecretBox, redactor: Redactor) -> None:
        self.db, self.box, self.redactor = db, box, redactor
        self._cache: dict[tuple[str, str], str] = {}
        with db.session() as session:
            for row in session.query(Secret).all():
                try:
                    value = box.decrypt(row.ciphertext)
                except ValueError:
                    continue
                self._cache[(row.project_id or GLOBAL, row.name)] = value
                redactor.add(value)
        # The owner may provide the subscription's own token in the environment; the platform
        # never stores it, but makes sure it can never appear in output.
        redactor.add(os.environ.get(SUBSCRIPTION_ENV))

    def get(self, name: str, project_id: str | None = None) -> str | None:
        if project_id and (project_id, name) in self._cache:
            return self._cache[(project_id, name)]
        return self._cache.get((GLOBAL, name))

    def set(self, name: str, value: str, actor: str, project_id: str | None = None) -> dict:
        if not NAME.match(name):
            raise ValueError("secret names use UPPER_SNAKE_CASE")
        if FORBIDDEN_SECRET.match(name):
            raise ValueError(
                f"'{name}' cannot be stored: the platform uses only your Claude subscription and never stores "
                "Claude credentials (sign in with `pae claude-login`)"
            )
        if not value or len(value) > 10_000:
            raise ValueError("secret value must be 1 to 10000 characters")
        scope, hint = _scope(project_id), secret_hint(value)
        with self.db.session() as session:
            row = session.get(Secret, (name, scope))
            if row is None:
                session.add(Secret(name=name, project_id=scope, ciphertext=self.box.encrypt(value), hint=hint))
            else:
                row.ciphertext, row.hint = self.box.encrypt(value), hint
            session.add(AuditEntry(actor=actor, action="secret.set", target=name, details={"project_id": project_id}))
        old = self._cache.get((scope, name))
        self._cache[(scope, name)] = value
        self.redactor.add(value)
        if old and old != value:
            self.redactor.remove(old)
        return {"name": name, "hint": hint, "project_id": project_id or None}

    def delete(self, name: str, actor: str, project_id: str | None = None) -> None:
        scope = _scope(project_id)
        with self.db.session() as session:
            row = session.get(Secret, (name, scope))
            if row is None:
                raise KeyError(name)
            session.delete(row)
            session.add(
                AuditEntry(actor=actor, action="secret.delete", target=name, details={"project_id": project_id})
            )
        self._cache.pop((scope, name), None)  # keep redacting the old value: it may still appear in old output

    def list(self, project_id: str | None = None) -> list[dict]:
        """Global secrets, plus the given project's when a project is named."""
        scopes = [GLOBAL] + ([project_id] if project_id else [])
        with self.db.session() as session:
            rows = session.query(Secret).filter(Secret.project_id.in_(scopes)).order_by(Secret.name, Secret.project_id)
            return [
                {
                    "name": r.name,
                    "hint": r.hint,
                    "project_id": r.project_id or None,
                    "source": "stored",
                    "updated_at": r.updated_at.isoformat(),
                }
                for r in rows
            ]
