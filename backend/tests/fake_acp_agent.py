"""A test double for an agent that speaks the Agent Client Protocol: it plays a scenario, no model, no network.

Usage: python fake_acp_agent.py <scenario.json> <log.jsonl>

The scenario is {"auth_required": bool, "protocol": int, "turns": [[step, ...], ...]}: each session/prompt plays the
next turn. Steps:
  {"say": text} {"think": text} {"plan": [entries]} {"report": object}
  {"tool": {...tool call fields...}, "ask": bool, "write": {"path", "content"}, "result": text}
  {"read": {"path", "line", "limit"}} {"write": {"path", "content"}} {"stop": stopReason}
Everything the client answers, and the agent's environment, is written to the log for the test to check.
"""

from __future__ import annotations

import json
import os
import sys

SCENARIO = json.load(open(sys.argv[1], encoding="utf-8"))
LOG = open(sys.argv[2], "a", encoding="utf-8")
NEXT_ID = [1000]
WAITING: list[dict] = []
CANCELLED = [False]


def log(event: str, **data) -> None:
    LOG.write(json.dumps({"event": event, **data}) + "\n")
    LOG.flush()


def send(message: dict) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def receive() -> dict | None:
    if WAITING:
        return WAITING.pop(0)
    line = sys.stdin.readline()
    return json.loads(line) if line else None


def call(method: str, params: dict) -> dict:
    """A request to the client; returns its response, keeping what else arrives for later."""
    NEXT_ID[0] += 1
    request_id = NEXT_ID[0]
    send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
    held = []
    while True:
        line = sys.stdin.readline()
        if not line:
            sys.exit(0)
        message = json.loads(line)
        if message.get("id") == request_id and "method" not in message:
            WAITING.extend(held)
            return message
        if message.get("method") == "session/cancel":
            CANCELLED[0] = True
            log("cancel")
            continue
        held.append(message)


def update(session_id: str, data: dict) -> None:
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session_id, "update": data}})


def say(session_id: str, text: str) -> None:
    half = len(text) // 2  # in two chunks, as agents stream
    for part in (text[:half], text[half:]):
        update(session_id, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": part}})


def play(session_id: str, steps: list[dict]) -> str:
    stop = "end_turn"
    for step in steps:
        if CANCELLED[0]:
            return "cancelled"
        if "say" in step:
            say(session_id, step["say"])
        elif "think" in step:
            update(
                session_id, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": step["think"]}}
            )
        elif "plan" in step:
            update(session_id, {"sessionUpdate": "plan", "entries": step["plan"]})
        elif "report" in step:
            say(session_id, "Done.\n```json\n" + json.dumps(step["report"]) + "\n```")
        elif "read" in step:
            answer = call("fs/read_text_file", {"sessionId": session_id, **step["read"]})
            log("read", answer=answer)
        elif "write" in step and "tool" not in step:
            answer = call("fs/write_text_file", {"sessionId": session_id, **step["write"]})
            log("write", answer=answer)
        elif "tool" in step:
            tool = dict(step["tool"])
            update(session_id, {"sessionUpdate": "tool_call", "status": "pending", **tool})
            allowed = True
            if step.get("ask"):
                options = step.get("options") or [
                    {"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                    {"optionId": "allow-always", "name": "Always allow", "kind": "allow_always"},
                    {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"},
                ]
                answer = call(
                    "session/request_permission",
                    {"sessionId": session_id, "toolCall": {"toolCallId": tool["toolCallId"]}, "options": options},
                )
                log("permission", tool=tool["toolCallId"], answer=answer)
                outcome = (answer.get("result") or {}).get("outcome") or {}
                allowed = outcome.get("outcome") == "selected" and str(outcome.get("optionId", "")).startswith("allow")
            if allowed and "write" in step:
                answer = call("fs/write_text_file", {"sessionId": session_id, **step["write"]})
                log("write", answer=answer)
            result = step.get("result", "ok") if allowed else "rejected"
            update(
                session_id,
                {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": tool["toolCallId"],
                    "status": "completed" if allowed else "failed",
                    "content": [{"type": "content", "content": {"type": "text", "text": result}}],
                },
            )
        elif "stop" in step:
            stop = step["stop"]
    return "cancelled" if CANCELLED[0] else stop


def main() -> None:
    log("env", keys=sorted(k for k in os.environ if k.endswith("_API_KEY") or k.startswith(("OPENAI_", "ANTHROPIC_"))))
    turns = list(SCENARIO.get("turns", []))
    session_id = "sess_fake"
    while True:
        message = receive()
        if message is None:
            return
        method, request_id = message.get("method"), message.get("id")
        params = message.get("params") or {}
        if method == "initialize":
            log("initialize", params=params)
            result = {
                "protocolVersion": SCENARIO.get("protocol", 1),
                "agentCapabilities": {"loadSession": False},
                "agentInfo": {"name": "fake-agent", "title": "Fake agent", "version": "0.1"},
                "authMethods": [],
            }
            send({"jsonrpc": "2.0", "id": request_id, "result": result})
        elif method == "session/new":
            log("session_new", params=params)
            if SCENARIO.get("auth_required"):
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32000, "message": "Authentication required"},
                    }
                )
            else:
                send({"jsonrpc": "2.0", "id": request_id, "result": {"sessionId": session_id}})
        elif method == "session/prompt":
            text = params["prompt"][0]["text"]
            log("prompt", text=text)
            steps = turns.pop(0) if turns else [{"say": "Nothing more to do."}]
            stop = play(session_id, steps)
            send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": stop}})
        elif method == "session/cancel":
            CANCELLED[0] = True
            log("cancel")
        elif request_id is not None:
            send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "unknown"}})


if __name__ == "__main__":
    main()
