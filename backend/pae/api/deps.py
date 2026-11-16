"""Authentication: session cookie + CSRF header for the browser, bearer tokens for automation."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import Depends, HTTPException, Request

from pae.db import ApiToken, AuthSession, User, utcnow
from pae.security import token_hash

SESSION_COOKIE = "pae_session"
CSRF_HEADER = "x-csrf-token"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def platform(request: Request):
    return request.app.state.platform


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def authenticate(request: Request) -> dict | None:
    plat = request.app.state.platform
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        digest = token_hash(header[7:].strip())
        with plat.db.session() as session:
            token = session.query(ApiToken).filter_by(token_hash=digest).first()
            if token is None:
                return None
            token.last_used_at = utcnow()
            return {"actor": f"token:{token.name}", "kind": "token", "csrf": None}
    cookie = request.cookies.get(SESSION_COOKIE)
    if not cookie:
        return None
    with plat.db.session() as session:
        row = session.get(AuthSession, token_hash(cookie))
        if row is None or _aware(row.expires_at) < utcnow():
            return None
        user = session.get(User, row.user_id)
        if user is None:
            return None
        return {"actor": user.username, "kind": "session", "csrf": row.csrf_token, "user_id": user.id}


def require_auth(request: Request) -> dict:
    identity = authenticate(request)
    if identity is None:
        raise HTTPException(status_code=401, detail="authentication required")
    if identity["kind"] == "session" and request.method not in SAFE_METHODS:
        if request.headers.get(CSRF_HEADER) != identity["csrf"]:
            raise HTTPException(status_code=403, detail="missing or invalid CSRF token")
    return identity


Auth = Depends(require_auth)
