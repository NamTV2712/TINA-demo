from __future__ import annotations

import json
from collections import deque

import contracts
from worker.engine import ApprovalInputCursor, McpApprovalBroker, serve


_MATCH_APPROVE = object()
_MATCH_DENY = object()


class _Stream:
    def __init__(self, messages=()):
        self.messages = deque(messages)
        self.events: list[dict] = []
        self.reads: list[tuple[str, str, int]] = []

    def xadd(self, topic, fields):
        self.events.append({"topic": topic, "event": json.loads(fields["event"])})

    def xread(self, streams, *, count, block):
        topic, cursor = next(iter(streams.items()))
        self.reads.append((topic, cursor, block))
        if not self.messages:
            return []
        message = self.messages.popleft()
        if message in (_MATCH_APPROVE, _MATCH_DENY):
            request = next(
                event["event"] for event in reversed(self.events)
                if event["event"]["type"] == "tool-approval-request"
            )
            message = {
                "type": "tool-approval-response",
                "approval_id": request["approval_id"],
                "turn_id": request["turn_id"],
                "decision": "approve" if message is _MATCH_APPROVE else "deny",
            }
        entry_id = f"{len(self.reads)}-0"
        return [(topic, [(entry_id, {"turn": json.dumps(message)})])]


def _request() -> dict:
    return {
        "server": "tina-email-send",
        "tool": "send",
        "title": "Send email",
        "description": "Send the prepared email",
        "message": "Allow sending this email?",
        "parameters": [
            {"name": "to", "display_name": "To", "value": "jane@example.test"},
            {"name": "api_token", "display_name": "API token", "value": "must-not-leak"},
        ],
    }


def test_gate_approval_publishes_request_and_uses_matching_response():
    stream = _Stream([{"type": "message", "prompt": "queue this follow-up"}, _MATCH_APPROVE])
    cursor = ApprovalInputCursor(stream, "unit:u1:in", "0-0")
    broker = McpApprovalBroker(stream, "unit:u1:out", cursor, turn_id="t1", timeout_seconds=30)

    assert broker.request(_request()) is True

    events = [item["event"] for item in stream.events]
    assert [event["type"] for event in events] == [
        "tool-approval-request", "tool-approval-resolved",
    ]
    assert events[0]["turn_id"] == "t1"
    assert events[0]["parameters"][0]["value"] == "jane@example.test"
    assert events[0]["parameters"][1]["value"] == "[redacted]"
    assert "must-not-leak" not in json.dumps(events)
    assert events[1]["outcome"] == "approved"
    contracts.validate_tool_approval_event(events[0])
    contracts.validate_tool_approval_event(events[1])
    assert cursor.read_next(block=0)["prompt"] == "queue this follow-up"


def test_nested_approval_credentials_are_redacted_before_publish():
    stream = _Stream([_MATCH_APPROVE])
    cursor = ApprovalInputCursor(stream, "unit:u1:in", "0-0")
    broker = McpApprovalBroker(stream, "unit:u1:out", cursor, turn_id="t1", timeout_seconds=30)
    request = _request()
    request["parameters"].extend([
        {
            "name": "headers",
            "display_name": "Headers",
            "value": {"Authorization": "Bearer nested-secret", "X-Trace": "trace-1"},
        },
        {
            "name": "options",
            "display_name": "Options",
            "value": [{"name": "api_key", "value": "nested-list-secret"}],
        },
        {
            "name": "raw_headers",
            "display_name": "Raw headers",
            "value": json.dumps({"Authorization": "Bearer stringified-secret"}),
        },
    ])

    assert broker.request(request) is True

    event = stream.events[0]["event"]
    assert "nested-secret" not in json.dumps(event)
    assert "nested-list-secret" not in json.dumps(event)
    assert "stringified-secret" not in json.dumps(event)
    headers = next(parameter for parameter in event["parameters"] if parameter["name"] == "headers")
    assert json.loads(headers["value"]) == {
        "Authorization": "[redacted]",
        "X-Trace": "trace-1",
    }
    raw_headers = next(parameter for parameter in event["parameters"] if parameter["name"] == "raw_headers")
    assert json.loads(raw_headers["value"]) == {"Authorization": "[redacted]"}


def test_gate_approval_denial_is_terminal_for_that_call():
    stream = _Stream([_MATCH_DENY])
    cursor = ApprovalInputCursor(stream, "unit:u1:in", "0-0")
    broker = McpApprovalBroker(stream, "unit:u1:out", cursor, turn_id="t1", timeout_seconds=30)

    assert broker.request(_request()) is False
    assert stream.events[-1]["event"]["outcome"] == "denied"


def test_gate_approval_timeout_fails_closed_without_waiting():
    stream = _Stream()
    cursor = ApprovalInputCursor(stream, "unit:u1:in", "0-0")
    broker = McpApprovalBroker(stream, "unit:u1:out", cursor, turn_id="t1", timeout_seconds=0)

    assert broker.request(_request()) is None
    assert stream.events[-1]["event"]["outcome"] == "expired"
    assert stream.reads == []


def test_stop_during_gate_approval_marks_the_unit_for_exit():
    stream = _Stream([{"type": "stop"}])
    cursor = ApprovalInputCursor(stream, "unit:u1:in", "0-0")
    broker = McpApprovalBroker(stream, "unit:u1:out", cursor, turn_id="t1", timeout_seconds=30)

    assert broker.request(_request()) is None
    assert cursor.stop_requested is True
    assert stream.events[-1]["event"]["outcome"] == "cancelled"


def test_approval_wait_preserves_fifo_order_for_queued_chat_messages():
    first = {"type": "message", "prompt": "first"}
    second = {"type": "message", "prompt": "second"}
    stream = _Stream([first, second, _MATCH_APPROVE])
    cursor = ApprovalInputCursor(stream, "unit:u1:in", "0-0")
    broker = McpApprovalBroker(stream, "unit:u1:out", cursor, turn_id="t1", timeout_seconds=30)

    assert broker.request(_request()) is True
    assert cursor.read_next(block=0) == first
    assert cursor.read_next(block=0) == second


def test_chat_worker_serves_an_approval_before_completing_the_turn():
    stream = _Stream([_MATCH_APPROVE])

    def turn(prompt, approval_port):
        approved = approval_port.request(_request())
        yield {"type": "message-delta", "text": f"{prompt}:{approved}"}

    serve(
        stream, out_topic="unit:u1:out", in_topic="unit:u1:in", turn=turn,
        start={"entrypoint": {"inline": "send"}}, idle_ms=1,
    )

    events = [item["event"] for item in stream.events]
    assert events[0] == {"type": "turn-accepted", "turn_id": "t0"}
    assert [event["type"] for event in events if event["type"].startswith("tool-approval-")] == [
        "tool-approval-request", "tool-approval-resolved",
    ]
    assert events[-2] == {"type": "message-delta", "text": "send:True", "turn_id": "t0"}
    assert events[-1] == {"type": "turn-complete", "turn_id": "t0"}
