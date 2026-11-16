"""The app watcher (pae.watch): free checks of a project's running app, Windows alerts, read-only diagnoses.

Docker, the port checks and Windows notifications are replaced by fakes; the rest is the real platform.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from pae import notify as notify_module
from pae.db import Run
from pae.watch import AppWatcher, Docker, parse_time, signature

from conftest import call, wait_for

pytestmark = pytest.mark.anyio

T0 = datetime(2026, 11, 13, 10, 0, tzinfo=UTC)
STEP = timedelta(minutes=2)
REPORT = {
    "status": "complete",
    "summary": "The frontend lost its link to the backend after Docker restarted; restarting both fixes it.",
    "reproduced": False,
    "root_cause": "Docker's network bridge went down",
    "evidence": ["frontend: connect() failed (111: Connection refused)"],
    "fix_summary": "restart the backend, then the frontend",
    "files_changed": [],
    "verification": "",
    "issues": [],
}


def service(name, ports=(), state="running", health="healthy"):
    return {
        "Service": name,
        "Name": f"app-{name}-1",
        "State": state,
        "Health": health,
        "Publishers": [{"URL": "127.0.0.1", "PublishedPort": p, "TargetPort": p, "Protocol": "tcp"} for p in ports],
    }


def stamp(when: datetime, text: str) -> str:
    return when.strftime("%Y-%m-%dT%H:%M:%S.123456789Z ") + text


class FakeDocker(Docker):
    def __init__(self):
        self.up = True
        self.items = [service("backend", [8000]), service("frontend", [8443]), service("status")]
        self.since_start: timedelta = timedelta(days=1)
        self.now = T0
        self.lines: dict[str, list[str]] = {}

    def services(self, folder):
        return [dict(s) for s in self.items] if self.up else None

    def started(self, names):
        return {n: self.now - self.since_start for n in names}

    def logs(self, folder, service, since):
        return self.lines.pop(service, [])


@pytest.fixture
async def watched(platform, monkeypatch):
    platform.settings.set("notifications.windows", True)  # a fake notifier below
    project = platform.projects.create(name="Shop", actor="owner")
    (Path(project["workspace"]) / "docker-compose.yml").write_text("services: {}\n")
    platform.projects.update(project["id"], {"watch": {"on": True}}, actor="owner")
    docker, dead, sent = FakeDocker(), set(), []

    async def answers(port):
        return port not in dead

    watcher = AppWatcher(platform, docker=docker, answers=answers, notify=lambda *a: sent.append(a) or True)
    watcher.poll_s = 0.02
    original = platform.manager.submit

    async def scripted_submit(**kwargs):  # the Debugger runs on the scripted test double
        options = {**kwargs.pop("options"), "provider_options": {"script": [call("final_answer", **REPORT)]}}
        return await original(**kwargs, options=options, provider="scripted")

    monkeypatch.setattr(platform.manager, "submit", scripted_submit)

    async def check(at: datetime):
        docker.now = at
        await watcher.check_all(now=at)

    return {"project": project, "docker": docker, "dead": dead, "sent": sent, "check": check, "watcher": watcher}


def runs_of(platform, project_id):
    with platform.db.session() as s:
        return s.query(Run).filter(Run.project_id == project_id).all()


async def until(predicate, timeout=10.0):
    for _ in range(int(timeout / 0.02)):
        if predicate():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("timed out")


async def test_a_healthy_app_costs_nothing_and_alerts_nobody(platform, watched):
    for n in range(3):
        await watched["check"](T0 + n * STEP)
    assert watched["sent"] == [] and runs_of(platform, watched["project"]["id"]) == []


async def test_a_port_that_stops_answering_alerts_once_then_says_when_it_is_back(platform, watched):
    check, sent, dead = watched["check"], watched["sent"], watched["dead"]
    dead.add(8443)
    await check(T0)
    assert sent == [], "one failed check is not enough: the app's own monitor may restart it"
    await check(T0 + STEP)
    title, body, url = sent[0]
    assert title == "Shop: a problem in the app"
    assert "frontend doesn't answer on port 8443" in body and "The Debugger is looking for the cause" in body

    [run] = runs_of(platform, watched["project"]["id"])
    assert run.agent_id == "debugging" and run.options["read_only"] is True, "the diagnosis changes nothing"
    assert url.endswith(f"/workspace/{run.id}") and "doesn't answer on port 8443" in run.task
    await wait_for(platform, run.id)
    await until(lambda: len(sent) == 2)
    assert sent[1][0] == "Shop: the Debugger found the cause" and sent[1][1] == REPORT["summary"]

    await check(T0 + 2 * STEP)
    assert len(sent) == 2, "the same problem alerts once"
    dead.clear()
    await check(T0 + 3 * STEP)
    assert sent[2][:2] == ("Shop: back to normal", "frontend answers on port 8443 again")


async def test_new_log_errors_alert_once_and_routine_noise_never(platform, watched):
    platform.settings.set("watch.diagnose", False)
    check, sent, docker = watched["check"], watched["sent"], watched["docker"]
    docker.lines = {
        "backend": [
            stamp(T0 - timedelta(seconds=30), "2026-11-13 10:59:30,123 ERROR [orders] Order 4512 failed"),
            stamp(T0 - timedelta(seconds=20), "WARNING [pypdf._reader] Ignoring wrong pointing object 12 0"),
        ],
        "frontend": [
            stamp(
                T0 - timedelta(seconds=10),
                '[error] 7#7: *9 open() "/usr/share/nginx/html/.env" failed (2: No such file or directory)',
            ),  # noqa: E501
        ],
    }
    await check(T0)
    assert [s[1] for s in sent] == ["backend: 1 new error line in its logs."]

    docker.lines = {"backend": [stamp(T0 + STEP, "2026-11-13 11:01:30,456 ERROR [orders] Order 9921 failed")]}
    await check(T0 + STEP)
    assert len(sent) == 1, "the same error with another number is not new"

    failures = [stamp(T0 + 2 * STEP, f'172.18.0.1 - - "GET /api/jobs HTTP/1.1" 502 157 "-" {n}') for n in range(3)]
    docker.lines = {"frontend": failures}
    await check(T0 + 2 * STEP)
    assert sent[1][1] == "frontend: 3 failed requests in 2 minutes."


async def test_a_long_task_that_never_ends_and_the_projects_own_patterns_alert(platform, watched):
    platform.settings.set("watch.diagnose", False)
    rules = {
        "alert": [r"\b[1-9]\d* failed"],
        "long_task": {
            "start": r"Sync: started for (?P<id>\S+)",
            "end": r"Sync: finished for (?P<id>\S+)",
            "max_minutes": 75,
            "label": "sync",
        },
    }
    platform.projects.update(watched["project"]["id"], {"watch": rules}, actor="owner")
    watched["docker"].lines = {
        "backend": [
            stamp(T0 - timedelta(minutes=90), "INFO Sync: started for job-b (40 orders)"),
            stamp(T0 - timedelta(minutes=80), "INFO Sync: started for job-a (192 orders)"),
            stamp(T0 - timedelta(minutes=20), "INFO Sync: finished for job-b (40 done, 0 failed)"),
            stamp(T0 - timedelta(seconds=40), "INFO Sync: finished for job-c (12 done, 2 failed)"),
        ]
    }
    await watched["check"](T0)
    [(title, body, _url)] = watched["sent"]
    assert body == "backend: 1 new error line in its logs (and 1 more)."
    alert = platform.db.session
    with alert() as s:
        from pae.db import AuditEntry

        found = s.query(AuditEntry).filter(AuditEntry.action == "watch.alert").one().details["found"]
    assert "a sync has been running for more than 75 minutes" in found, "job-a started and never ended"
    assert len(found) == 2, "job-b ended in time"


async def test_stopped_services_restarts_and_docker_itself(platform, watched):
    platform.settings.set("watch.diagnose", False)
    check, sent, docker, dead = watched["check"], watched["sent"], watched["docker"], watched["dead"]
    docker.items[2] = service("status", state="exited")  # stopped by the owner: a choice, never an alert
    docker.since_start = timedelta(minutes=1)  # just (re)started: ports get time to come up
    dead.add(8443)
    for n in range(3):
        await check(T0 + n * STEP)
    assert sent == []

    docker.up = False
    for n in range(3, 5):
        await check(T0 + n * STEP)
    assert sent == [], "Docker may still be starting"
    await check(T0 + 5 * STEP)
    assert sent[0][1] == "Docker isn't answering on this PC: the app may be down."
    docker.up, docker.since_start = True, timedelta(days=1)
    dead.clear()
    await check(T0 + 6 * STEP)
    assert sent[1][:2] == ("Shop: back to normal", "Docker answers again")


async def test_diagnoses_are_capped_per_day(platform, watched):
    platform.settings.set("watch.max_diagnoses_per_day", 1)
    check, sent, dead = watched["check"], watched["sent"], watched["dead"]
    dead.add(8000)
    await check(T0)
    await check(T0 + STEP)
    [first] = runs_of(platform, watched["project"]["id"])
    await wait_for(platform, first.id)
    dead.clear()
    watched["docker"].lines = {"backend": [stamp(T0 + 2 * STEP, "CRITICAL database is locked")]}
    await check(T0 + 2 * STEP)
    alert = [s for s in sent if s[0] == "Shop: a problem in the app"][-1]
    assert alert[1] == "backend: 1 new error line in its logs.", "alerted, but no second diagnosis today"
    assert len(runs_of(platform, watched["project"]["id"])) == 1


async def test_watching_stops_with_the_switch(platform, watched):
    platform.projects.update(watched["project"]["id"], {"watch": {"on": False}}, actor="owner")
    watched["dead"].add(8443)
    for n in range(3):
        await watched["check"](T0 + n * STEP)
    assert watched["sent"] == [] and watched["watcher"].states == {}


def test_docker_times_and_error_signatures():
    assert parse_time("2026-11-13T09:12:33.123456789Z") == datetime(2026, 11, 13, 9, 12, 33, 123456, UTC)
    assert parse_time("not a time") is None
    one = signature("2026-11-13 10:00:01,123 ERROR [sync] job 3f2a9c1e-77ab failed after 3 tries")
    other = signature("2026-11-14 08:12:44,999 ERROR [sync] job 9b1c0d2e-11cd failed after 5 tries")
    assert one == other and "ERROR [sync]" in one


def test_a_windows_notification_carries_no_command(monkeypatch):
    xml = notify_module.toast_xml('Shop: <a problem> & "more"', "body", "http://127.0.0.1:8600/workspace/x?a=1&b=2")
    assert "&lt;a problem&gt; &amp;" in xml and 'launch="http://127.0.0.1:8600/workspace/x?a=1&amp;b=2"' in xml
    if os.name != "nt":
        assert notify_module.notify("t", "b") is False
        return
    seen = {}

    def fake_run(args, **kwargs):
        seen["args"], seen["env"] = args, kwargs["env"]
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(notify_module.subprocess, "run", fake_run)
    assert notify_module.notify("Shop'; Remove-Item C:\\ #", "body") is True
    assert "Remove-Item" not in " ".join(seen["args"]), "the text never reaches the command line"
    assert "Remove-Item" in seen["env"]["PAE_TOAST_XML"]
