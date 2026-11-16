from __future__ import annotations

from pae.security import RateLimiter, Redactor, SecretBox, hash_password, secret_hint, verify_password


def test_password_hash_roundtrip():
    stored = hash_password("correct horse battery")
    assert stored.startswith("scrypt$") and "correct" not in stored
    assert verify_password("correct horse battery", stored)
    assert not verify_password("wrong password!!", stored)
    assert not verify_password("x", "garbage")


def test_redactor_known_values_patterns_and_keys():
    redactor = Redactor()
    redactor.add("my-very-secret-value")
    text = (
        "value my-very-secret-value, key sk-ant-api03-ABCDEFGHIJKLMNOP, gh ghp_abcdefghijklmnopqrstuvwxyz0123, "
        "Bearer abcdefghijklmnopqrstuvwxyz, password=hunter22, https://user:pa55word@host/x"
    )
    out = redactor.text(text)
    for leaked in (
        "my-very-secret-value",
        "sk-ant-api03-ABCDEFGHIJKLMNOP",
        "ghp_abcdefghijklmnopqrstuvwxyz0123",
        "abcdefghijklmnopqrstuvwxyz",
        "hunter22",
        "pa55word",
    ):
        assert leaked not in out
    data = redactor.obj(
        {
            "headers": {"Authorization": "x", "x-api-key": "y"},
            "max_tokens": 16000,
            "usage": {"input_tokens": 5},
            "api_key": "z",
            "note": "keep",
        }
    )
    assert data["headers"] == {"Authorization": "[REDACTED]", "x-api-key": "[REDACTED]"}
    assert data["max_tokens"] == 16000 and data["usage"]["input_tokens"] == 5
    assert data["api_key"] == "[REDACTED]" and data["note"] == "keep"


def test_secret_box_roundtrip_and_key_file(tmp_path):
    key_file = tmp_path / "secret.key"
    box = SecretBox(key_file)
    cipher = box.encrypt("value-123")
    assert "value-123" not in cipher and key_file.exists()
    assert SecretBox(key_file).decrypt(cipher) == "value-123"
    assert secret_hint("abcdefgh1234") == "...1234"


def test_rate_limiter():
    limiter = RateLimiter(max_events=3, window_s=60)
    assert all(limiter.hit("k") for _ in range(3))
    assert not limiter.hit("k")
    limiter.reset("k")
    assert limiter.hit("k")
