"""Execution events: redacted, persisted first, then fanned out to live subscribers."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from sqlalchemy import func, select

from pae.db import Database, RunEvent, utcnow

SOURCES = ("agent", "tool", "runtime", "user")


@dataclass
class Subscription:
    run_id: str | None = None
    root_run_id: str | None = None
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=2000))
    overflowed: bool = False

    def matches(self, event: dict) -> bool:
        if self.run_id and event["run_id"] != self.run_id:
            return False
        if self.root_run_id and event["root_run_id"] != self.root_run_id:
            return False
        return True


def serialize(row: RunEvent) -> dict:
    return {
        "id": row.id,
        "run_id": row.run_id,
        "root_run_id": row.root_run_id,
        "seq": row.seq,
        "ts": row.ts.isoformat(),
        "type": row.type,
        "source": row.source,
        "data": row.data,
    }


class EventBus:
    def __init__(self, db: Database, redactor) -> None:
        self.db = db
        self.redactor = redactor
        self._seq: dict[str, int] = {}
        self._subs: list[Subscription] = []

    def _next_seq(self, session, run_id: str) -> int:
        if run_id not in self._seq:
            current = session.execute(select(func.max(RunEvent.seq)).where(RunEvent.run_id == run_id)).scalar()
            self._seq[run_id] = current or 0
        self._seq[run_id] += 1
        return self._seq[run_id]

    async def emit(self, run_id: str, root_run_id: str, type_: str, source: str, data: dict | None = None) -> dict:
        if source not in SOURCES:
            raise ValueError(f"invalid event source {source}")
        payload = self.redactor.obj(data or {})
        with self.db.session() as session:
            row = RunEvent(
                run_id=run_id,
                root_run_id=root_run_id,
                seq=self._next_seq(session, run_id),
                ts=utcnow(),
                type=type_,
                source=source,
                data=payload,
            )
            session.add(row)
            session.flush()
            event = serialize(row)
        for sub in list(self._subs):
            if sub.matches(event):
                try:
                    sub.queue.put_nowait(event)
                except asyncio.QueueFull:
                    sub.overflowed = True  # the client reconnects and replays from the database
        return event

    def subscribe(self, run_id: str | None = None, root_run_id: str | None = None) -> Subscription:
        sub = Subscription(run_id=run_id, root_run_id=root_run_id)
        self._subs.append(sub)
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        if sub in self._subs:
            self._subs.remove(sub)

    def history(
        self, *, run_id: str | None = None, root_run_id: str | None = None, after_id: int = 0, limit: int = 5000
    ) -> list[dict]:
        with self.db.session() as session:
            query = select(RunEvent).where(RunEvent.id > after_id)
            if run_id:
                query = query.where(RunEvent.run_id == run_id)
            if root_run_id:
                query = query.where(RunEvent.root_run_id == root_run_id)
            rows = session.execute(query.order_by(RunEvent.id).limit(limit)).scalars().all()
            return [serialize(r) for r in rows]

    def forget(self, run_id: str) -> None:
        self._seq.pop(run_id, None)
