from __future__ import annotations

import pytest

import contracts


@pytest.mark.parametrize("event", [
    {
        "type": "tool-approval-request",
        "approval_id": "00000000-0000-4000-8000-000000000001",
        "turn_id": "t0",
        "server": "tina-email-send",
        "tool": "send",
        "title": "Send email",
        "description": "Send the prepared email",
        "message": "Allow sending this email?",
        "parameters": [{"name": "to", "display_name": "To", "value": "jane@example.test"}],
        "expires_at": 1_798_252_800_000,
    },
    {
        "type": "tool-approval-response",
        "approval_id": "00000000-0000-4000-8000-000000000001",
        "turn_id": "t0",
        "decision": "approve",
    },
    {
        "type": "tool-approval-resolved",
        "approval_id": "00000000-0000-4000-8000-000000000001",
        "turn_id": "t0",
        "outcome": "denied",
    },
])
def test_tool_approval_event_contract_accepts_valid_messages(event):
    contracts.validate_tool_approval_event(event)


@pytest.mark.parametrize("event", [
    {
        "type": "tool-approval-response",
        "approval_id": "not-a-uuid",
        "turn_id": "t0",
        "decision": "approve",
    },
    {
        "type": "tool-approval-response",
        "approval_id": "00000000-0000-4000-8000-000000000001",
        "turn_id": "t0",
        "decision": "allow-always",
    },
])
def test_tool_approval_event_contract_rejects_invalid_messages(event):
    with pytest.raises(Exception):
        contracts.validate_tool_approval_event(event)
