"""HTTP tools with SSRF protection, domain allowlists and server-side secret injection.

Header values may contain {{secret:NAME}}. The platform substitutes the secret at
execution time; the model, the events and the UI only ever see the placeholder.
"""

from __future__ import annotations

import asyncio
import fnmatch
import ipaddress
import json
import re
import socket
from typing import Any, Literal
from urllib.parse import urljoin, urlparse

import httpx
from pydantic import Field

from pae.tools.base import Args, Permission, Tool, ToolContext, ToolError, ToolResult, truncate
from pae.tools.documents import html_to_text

MAX_BODY = 2_000_000
SECRET_REF = re.compile(r"\{\{secret:([A-Za-z0-9_\-]+)\}\}")


async def check_url(url: str, ctx: ToolContext) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ToolError("only absolute http(s) URLs are allowed")
    if ctx.settings.get("http.allow_private_network"):
        return
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(
            parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM
        )
    except socket.gaierror as exc:
        raise ToolError(f"cannot resolve host '{parsed.hostname}'") from exc
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
            or address.is_unspecified
        ):
            raise ToolError(
                f"'{parsed.hostname}' resolves to a private or local address; "
                "enable http.allow_private_network in Settings to allow it"
            )


def domain_allowed(url: str, ctx: ToolContext) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return any(fnmatch.fnmatch(host, pattern.lower()) for pattern in ctx.settings.get("http.allowed_domains", []))


def inject_secrets(headers: dict[str, str], ctx: ToolContext) -> dict[str, str]:
    def replace(match: re.Match) -> str:
        value = ctx.secrets(match.group(1))
        if value is None:
            raise ToolError(f"secret '{match.group(1)}' is not defined")
        return value

    return {k: SECRET_REF.sub(replace, v) for k, v in headers.items()}


async def fetch(
    method: str, url: str, ctx: ToolContext, *, headers: dict | None = None, body: Any = None, timeout: float = 30.0
) -> httpx.Response:
    real_headers = inject_secrets(headers or {}, ctx)
    current = url
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        for _ in range(4):
            await check_url(current, ctx)
            kwargs: dict = {"headers": real_headers}
            if body is not None:
                kwargs["content" if isinstance(body, str) else "json"] = body
            response = await client.request(method, current, **kwargs)
            if response.is_redirect and response.headers.get("location"):
                current = urljoin(current, response.headers["location"])
                method, body = ("GET", None) if response.status_code in (301, 302, 303) else (method, body)
                continue
            return response
    raise ToolError("too many redirects")


def _body_text(response: httpx.Response) -> str:
    raw = response.content[:MAX_BODY]
    return raw.decode(response.encoding or "utf-8", errors="replace")


class HttpArgs(Args):
    method: Literal["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] = "GET"
    url: str
    headers: dict[str, str] = Field(default_factory=dict, description="Header values may reference {{secret:NAME}}")
    body: Any = Field(None, description="JSON value or string body")
    timeout_s: float = Field(30, ge=1, le=120)


def http_permission(args: HttpArgs, ctx: ToolContext) -> Permission | None:
    if args.method in {"GET", "HEAD"} and domain_allowed(args.url, ctx):
        return "allow"
    return None  # fall back to the configured policy (ask)


async def http_request(args: HttpArgs, ctx: ToolContext) -> ToolResult:
    try:
        response = await fetch(args.method, args.url, ctx, headers=args.headers, body=args.body, timeout=args.timeout_s)
    except httpx.HTTPError as exc:
        raise ToolError(f"request failed: {exc}") from exc
    text = ctx.redactor.text(_body_text(response))
    content_type = response.headers.get("content-type", "")
    summary = {"status": response.status_code, "content_type": content_type, "bytes": len(response.content)}
    return ToolResult(
        f"HTTP {response.status_code} ({content_type})\n" + truncate(text, 80_000),
        summary,
        is_error=response.status_code >= 400,
    )


class FetchArgs(Args):
    url: str
    max_chars: int = Field(60_000, ge=1000, le=300_000)


def fetch_permission(args: FetchArgs, ctx: ToolContext) -> Permission | None:
    return "allow" if domain_allowed(args.url, ctx) else None


async def web_fetch(args: FetchArgs, ctx: ToolContext) -> ToolResult:
    try:
        response = await fetch("GET", args.url, ctx, headers={"user-agent": "pae-agent/0.1"})
    except httpx.HTTPError as exc:
        raise ToolError(f"fetch failed: {exc}") from exc
    content_type = response.headers.get("content-type", "")
    text = _body_text(response)
    if "html" in content_type:
        text = html_to_text(text)
    text = ctx.redactor.text(text)
    return ToolResult(
        f"[{args.url} -> HTTP {response.status_code}]\n" + truncate(text, args.max_chars),
        {"status": response.status_code, "url": str(response.url), "characters": len(text)},
        is_error=response.status_code >= 400,
    )


class WebhookArgs(Args):
    url: str
    payload: dict
    headers: dict[str, str] = Field(default_factory=dict)


async def webhook_send(args: WebhookArgs, ctx: ToolContext) -> ToolResult:
    try:
        response = await fetch(
            "POST",
            args.url,
            ctx,
            headers={"content-type": "application/json", **args.headers},
            body=json.loads(json.dumps(args.payload)),
        )
    except httpx.HTTPError as exc:
        raise ToolError(f"webhook failed: {exc}") from exc
    return ToolResult(
        f"webhook answered HTTP {response.status_code}: {truncate(_body_text(response), 2000)}",
        {"status": response.status_code},
        is_error=response.status_code >= 400,
    )


TOOLS = [
    Tool(
        "http_request",
        "Make an HTTP request to an external API. Non-GET methods need approval.",
        HttpArgs,
        http_request,
        "external",
        "ask",
        "web",
        untrusted_output=True,
        timeout_s=130,
        dynamic_permission=http_permission,
    ),
    Tool(
        "web_fetch",
        "Fetch a web page and return its readable text.",
        FetchArgs,
        web_fetch,
        "external",
        "ask",
        "web",
        untrusted_output=True,
        timeout_s=60,
        dynamic_permission=fetch_permission,
    ),
    Tool(
        "webhook_send",
        "POST a JSON payload to a webhook (Slack, Teams, automation services...).",
        WebhookArgs,
        webhook_send,
        "external",
        "ask",
        "web",
        timeout_s=60,
    ),
]
