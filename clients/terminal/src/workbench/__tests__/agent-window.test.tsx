import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Conversation, type Turn } from "../agent-window";

afterEach(cleanup);

const approval = {
  type: "tool-approval-request" as const,
  approval_id: "00000000-0000-4000-8000-000000000001",
  turn_id: "t0",
  server: "tina-email-send",
  tool: "send",
  title: "Send email",
  description: "Send the prepared email",
  message: "Allow sending this email?",
  parameters: [{ name: "to", display_name: "To", value: "jane@example.test" }],
  expires_at: 1_798_252_800_000,
};

describe("Conversation MCP approval card", () => {
  it("shows the exact request and lets the owner approve once or deny", () => {
    const onApprovalDecision = vi.fn();
    const turn: Turn = {
      id: "agent-1",
      role: "agent",
      text: "",
      ops: [],
      approvals: [{ ...approval, status: "pending" }],
    };

    render(<Conversation turns={[turn]} onApprovalDecision={onApprovalDecision} />);

    expect(screen.getByText("Allow sending this email?")).toBeTruthy();
    expect(screen.getByText("jane@example.test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(onApprovalDecision).toHaveBeenCalledWith(approval.approval_id, "approve");
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onApprovalDecision).toHaveBeenCalledWith(approval.approval_id, "deny");
  });

  it("keeps resolved requests visible without leaving approval controls", () => {
    const turn: Turn = {
      id: "agent-1",
      role: "agent",
      text: "",
      ops: [],
      approvals: [{ ...approval, status: "denied" }],
    };

    render(<Conversation turns={[turn]} onApprovalDecision={vi.fn()} />);

    expect(screen.getByText("Denied")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve once" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });
});
