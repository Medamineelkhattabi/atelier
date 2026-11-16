"""Which process owns a platform instance (its data folder): normally the server.

Only the owner recovers what a stopped server left unfinished, cleans up old tasks and watches the projects' apps. A
`pae` command started while the server runs on the same data folder (an eval, a run) only runs its own tasks: before
this lock it marked the server's running tasks "interrupted" and cancelled their pending approvals.

The lock is an OS file lock, released by the OS if the process dies, so a crashed server never blocks the next one.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import BinaryIO


class InstanceLock:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._file: BinaryIO | None = None

    @property
    def held(self) -> bool:
        return self._file is not None

    def acquire(self) -> bool:
        """Take the lock if no other process holds it. Never waits."""
        if self._file is not None:
            return True
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(self.path, "a+b")  # noqa: SIM115 - stays open while the lock is held
        try:
            _lock(handle)
        except OSError:
            handle.close()
            return False
        self._file = handle
        return True

    def release(self) -> None:
        handle, self._file = self._file, None
        if handle is None:
            return
        try:
            _unlock(handle)
        except OSError:
            pass  # closing the file releases it anyway
        finally:
            handle.close()


if os.name == "nt":
    import msvcrt

    def _lock(handle: BinaryIO) -> None:
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)

    def _unlock(handle: BinaryIO) -> None:
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)

else:
    import fcntl

    def _lock(handle: BinaryIO) -> None:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _unlock(handle: BinaryIO) -> None:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
