"""Email over SMTP. Available only when SMTP is configured in Settings; always needs approval."""

from __future__ import annotations

import asyncio
import smtplib
import ssl
from email.message import EmailMessage

from pydantic import Field

from pae.tools.base import Args, Tool, ToolContext, ToolError, ToolResult


class EmailArgs(Args):
    to: list[str] = Field(min_length=1, max_length=20)
    subject: str = Field(max_length=300)
    body: str = Field(max_length=100_000)


def _send(config: dict, password: str | None, message: EmailMessage) -> None:
    host, port = config["host"], int(config.get("port", 587))
    security = config.get("security", "starttls")
    if security == "ssl":
        server = smtplib.SMTP_SSL(host, port, timeout=30, context=ssl.create_default_context())
    else:
        server = smtplib.SMTP(host, port, timeout=30)
    try:
        if security == "starttls":
            server.starttls(context=ssl.create_default_context())
        if config.get("username"):
            server.login(config["username"], password or "")
        server.send_message(message)
    finally:
        server.quit()


async def email_send(args: EmailArgs, ctx: ToolContext) -> ToolResult:
    config = ctx.settings.get("email.smtp") or {}
    if not config.get("host") or not config.get("from"):
        raise ToolError("email is not configured (Settings > Integrations > SMTP)")
    allowed = [d.lower() for d in config.get("allowed_recipient_domains", [])]
    for address in args.to:
        if "@" not in address:
            raise ToolError(f"invalid address '{address}'")
        if allowed and address.rsplit("@", 1)[1].lower() not in allowed:
            raise ToolError(f"recipient domain of '{address}' is not in the allowed list")
    message = EmailMessage()
    message["From"], message["To"], message["Subject"] = config["from"], ", ".join(args.to), args.subject
    message.set_content(args.body)
    password = ctx.secrets(config["password_secret"]) if config.get("password_secret") else None
    try:
        await asyncio.to_thread(_send, config, password, message)
    except (smtplib.SMTPException, OSError) as exc:
        raise ToolError(f"SMTP error: {exc}") from exc
    return ToolResult(f"email sent to {', '.join(args.to)}", {"recipients": args.to, "subject": args.subject})


TOOLS = [
    Tool(
        "email_send",
        "Send a plain-text email through the configured SMTP server.",
        EmailArgs,
        email_send,
        "external",
        "ask",
        "messaging",
        timeout_s=60,
    ),
]
