"""Passwords, tokens, secret encryption and redaction."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import threading
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

# ---------------------------------------------------------------- passwords

_SCRYPT = {"n": 2**15, "r": 8, "p": 1, "maxmem": 64 * 1024 * 1024}


def hash_password(password: str) -> str:
    if len(password) < 10:
        raise ValueError("password must be at least 10 characters")
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_SCRYPT)
    return f"scrypt${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_b64, digest_b64 = stored.split("$")
    except ValueError:
        return False
    if scheme != "scrypt":
        return False
    digest = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt_b64), dklen=32, **_SCRYPT)
    return hmac.compare_digest(digest, base64.b64decode(digest_b64))


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ---------------------------------------------------------------- rate limiting


class RateLimiter:
    """Sliding-window counter, in memory (one process, one owner)."""

    def __init__(self, max_events: int, window_s: float) -> None:
        self.max_events = max_events
        self.window_s = window_s
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key: str) -> bool:
        """Record an event; return False if the key is over its limit."""
        now = time.monotonic()
        with self._lock:
            events = self._events[key]
            while events and now - events[0] > self.window_s:
                events.popleft()
            if len(events) >= self.max_events:
                return False
            events.append(now)
            return True

    def reset(self, key: str) -> None:
        with self._lock:
            self._events.pop(key, None)


# ---------------------------------------------------------------- secret encryption


class SecretBox:
    """Fernet encryption with a key kept outside the database and outside Git."""

    def __init__(self, key_file: Path, env_key: str | None = None) -> None:
        key = env_key or os.environ.get("PAE_MASTER_KEY")
        if not key:
            if key_file.exists():
                key = key_file.read_text().strip()
            else:
                key = Fernet.generate_key().decode()
                key_file.parent.mkdir(parents=True, exist_ok=True)
                key_file.write_text(key)
                try:
                    key_file.chmod(0o600)
                except OSError:
                    pass
        self._fernet = Fernet(key.encode() if isinstance(key, str) else key)

    def encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode()).decode()

    def decrypt(self, ciphertext: str) -> str:
        try:
            return self._fernet.decrypt(ciphertext.encode()).decode()
        except InvalidToken as exc:
            raise ValueError("secret cannot be decrypted with the current master key") from exc


def secret_hint(value: str) -> str:
    return "..." + value[-4:] if len(value) >= 8 else "set"


# ---------------------------------------------------------------- redaction

_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-~+/]{16,}=*"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)(\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[=:]\s*)([^\s,;\"']{4,})"),
    re.compile(r"(?i)(://[^/\s:@]+:)([^@\s/]+)(@)"),
]
REDACTED = "[REDACTED]"
# Exact key names only: "max_tokens" or "input_tokens" must stay readable.
SENSITIVE_KEYS = re.compile(
    r"(?i)^(authorization|proxy-authorization|x-api-key|api[_-]?key|apikey|token|access[_-]?token|"
    r"refresh[_-]?token|.*[_-]token|secret|.*[_-]secret|password|passwd|pwd|cookie|set-cookie|"
    r"credentials?|private[_-]?key)$"
)


class Redactor:
    """Removes known secret values and common credential shapes from any payload."""

    def __init__(self) -> None:
        self._values: set[str] = set()
        self._lock = threading.Lock()

    def add(self, value: str | None) -> None:
        if value and len(value) >= 6:
            with self._lock:
                self._values.add(value)

    def remove(self, value: str | None) -> None:
        with self._lock:
            self._values.discard(value or "")

    def text(self, value: str) -> str:
        if not value:
            return value
        with self._lock:
            known = sorted(self._values, key=len, reverse=True)
        for secret in known:
            if secret in value:
                value = value.replace(secret, REDACTED)
        for pattern in _PATTERNS:
            if pattern.groups >= 2:
                value = pattern.sub(lambda m: m.group(1) + REDACTED + (m.group(3) if m.lastindex == 3 else ""), value)
            else:
                value = pattern.sub(REDACTED, value)
        return value

    def obj(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, dict):
            out = {}
            for key, item in value.items():
                if isinstance(key, str) and SENSITIVE_KEYS.search(key) and isinstance(item, str) and item:
                    out[key] = REDACTED
                else:
                    out[key] = self.obj(item)
            return out
        if isinstance(value, list | tuple):
            return [self.obj(item) for item in value]
        return value
