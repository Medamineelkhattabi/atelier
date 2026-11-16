"""Windows notifications for the owner, shown on this PC through Windows itself (no outside service).

A notification carries a short title and line, never log content (it can show personal data on screen);
clicking it opens the platform page given. Elsewhere than Windows, notifications are only logged.
"""

from __future__ import annotations

import logging
import os
import subprocess
from xml.sax.saxutils import escape, quoteattr

log = logging.getLogger("pae.notify")

# Windows PowerShell's own application id: notifications need a registered app, and this one always is.
APP_ID = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
# The text arrives through environment variables, so nothing in it is ever read as a command.
SCRIPT = (
    "$ErrorActionPreference = 'Stop';"
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications,"
    " ContentType = WindowsRuntime] | Out-Null;"
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;"
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument; $xml.LoadXml($env:PAE_TOAST_XML);"
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml;"
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:PAE_TOAST_APP).Show($toast)"
)


def toast_xml(title: str, body: str, url: str | None = None) -> str:
    launch = f' activationType="protocol" launch={quoteattr(url)}' if url else ""
    return (
        f'<toast{launch}><visual><binding template="ToastGeneric">'
        f"<text>{escape(title[:120])}</text><text>{escape(body[:300])}</text>"
        "</binding></visual></toast>"
    )


def notify(title: str, body: str, url: str | None = None) -> bool:
    """Show a Windows notification. True when Windows accepted it."""
    if os.name != "nt":
        log.info("notification (not on Windows, not shown): %s: %s", title, body)
        return False
    env = {**os.environ, "PAE_TOAST_XML": toast_xml(title, body, url), "PAE_TOAST_APP": APP_ID}
    try:
        done = subprocess.run(  # noqa: S603 - fixed command, text passed through the environment
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.warning("notification not shown: %s", exc)
        return False
    if done.returncode != 0:
        log.warning("notification not shown: %s", (done.stderr or done.stdout).strip()[:300])
        return False
    return True
