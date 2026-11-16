"""Human approval of sensitive tool calls."""

from __future__ import annotations

import asyncio
from datetime import timedelta

from pae.db import Approval, AuditEntry, Database, utcnow


class ApprovalError(Exception):
    pass


class ApprovalService:
    def __init__(self, db: Database, bus) -> None:
        self.db = db
        self.bus = bus
        self._waiters: dict[str, asyncio.Future] = {}

    async def request(
        self,
        *,
        run_id: str,
        root_run_id: str,
        agent_id: str,
        tool: str,
        tool_call_id: str,
        args: dict,
        risk: str,
        reason: str | None,
        timeout_s: float,
        on_wait=None,
        on_resume=None,
    ) -> tuple[str, str | None]:
        """Create a pending approval and wait for the owner. Returns (status, note)."""
        args = self.bus.redactor.obj(args)
        with self.db.session() as session:
            approval = Approval(
                run_id=run_id,
                root_run_id=root_run_id,
                agent_id=agent_id,
                tool=tool,
                tool_call_id=tool_call_id,
                args=args,
                risk=risk,
                reason=reason,
                status="pending",
                expires_at=utcnow() + timedelta(seconds=timeout_s),
            )
            session.add(approval)
            session.flush()
            approval_id = approval.id
        future = asyncio.get_running_loop().create_future()
        self._waiters[approval_id] = future
        await self.bus.emit(
            run_id,
            root_run_id,
            "approval.requested",
            "runtime",
            {
                "approval_id": approval_id,
                "tool": tool,
                "tool_call_id": tool_call_id,
                "args": args,
                "risk": risk,
                "reason": reason,
                "timeout_s": timeout_s,
            },
        )
        if on_wait:
            await on_wait()
        try:
            status, note = await asyncio.wait_for(asyncio.shield(future), timeout=timeout_s)
        except TimeoutError:
            self._finish(approval_id, "expired", "no decision before the timeout")
            await self.bus.emit(
                run_id, root_run_id, "approval.decided", "runtime", {"approval_id": approval_id, "decision": "expired"}
            )
            status, note = "expired", None
        except asyncio.CancelledError:
            # Left pending on purpose: the run's cleanup cancels it and emits the event.
            raise
        finally:
            self._waiters.pop(approval_id, None)
        if on_resume:
            await on_resume()
        return status, note

    def _finish(self, approval_id: str, status: str, note: str | None) -> bool:
        with self.db.session() as session:
            approval = session.get(Approval, approval_id)
            if approval is None or approval.status != "pending":
                return False
            approval.status, approval.note, approval.decided_at = status, note, utcnow()
            return True

    async def decide(self, approval_id: str, approve: bool, note: str | None, actor: str) -> dict:
        status = "approved" if approve else "rejected"
        with self.db.session() as session:
            approval = session.get(Approval, approval_id)
            if approval is None:
                raise ApprovalError("approval not found")
            if approval.status != "pending":
                raise ApprovalError(f"approval is already {approval.status}")
            approval.status, approval.note, approval.decided_at = status, note, utcnow()
            run_id, root_run_id, tool = approval.run_id, approval.root_run_id, approval.tool
            session.add(
                AuditEntry(
                    actor=actor,
                    action=f"approval.{status}",
                    target=approval_id,
                    details={"tool": tool, "run_id": run_id, "note": note},
                )
            )
        await self.bus.emit(
            run_id,
            root_run_id,
            "approval.decided",
            "user",
            {"approval_id": approval_id, "decision": status, "note": note, "tool": tool},
        )
        future = self._waiters.get(approval_id)
        if future and not future.done():
            future.set_result((status, note))
        return {"id": approval_id, "status": status}

    async def cancel_for_run(self, run_id: str, note: str) -> int:
        cancelled = []
        with self.db.session() as session:
            for approval in session.query(Approval).filter_by(run_id=run_id, status="pending"):
                approval.status, approval.note, approval.decided_at = "cancelled", note, utcnow()
                cancelled.append((approval.id, approval.root_run_id, approval.tool))
                future = self._waiters.get(approval.id)
                if future and not future.done():
                    future.set_result(("cancelled", note))
        for approval_id, root_run_id, tool in cancelled:
            await self.bus.emit(
                run_id,
                root_run_id,
                "approval.decided",
                "runtime",
                {"approval_id": approval_id, "decision": "cancelled", "note": note, "tool": tool},
            )
        return len(cancelled)

    async def expire_orphans(self) -> int:
        """When a process takes over the instance, pending approvals nobody here waits for belong to runs a stopped
        server left behind."""
        with self.db.session() as session:
            pending = session.query(Approval).filter_by(status="pending").all()
            pending = [a for a in pending if a.id not in self._waiters]
            orphans = [(a.id, a.run_id, a.root_run_id, a.tool) for a in pending]
            for approval in pending:
                approval.status, approval.note, approval.decided_at = "cancelled", "server restarted", utcnow()
        for approval_id, run_id, root_run_id, tool in orphans:
            await self.bus.emit(
                run_id,
                root_run_id,
                "approval.decided",
                "runtime",
                {"approval_id": approval_id, "decision": "cancelled", "note": "server restarted", "tool": tool},
            )
        return len(orphans)
