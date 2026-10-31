export type ToolApprovalParameter = { name: string; display_name: string; value: string };

export type ToolApprovalRequest = {
  type: "tool-approval-request";
  approval_id: string;
  turn_id: string;
  server: string;
  tool: string;
  title: string;
  description: string;
  message: string;
  parameters: ToolApprovalParameter[];
  expires_at: number;
};

export type ToolApprovalOutcome = "approved" | "denied" | "expired" | "cancelled";
export type ToolApprovalDecision = "approve" | "deny";
export type ToolApprovalResolved = {
  type: "tool-approval-resolved";
  approval_id: string;
  turn_id: string;
  outcome: ToolApprovalOutcome;
};

export type ToolApprovalState = ToolApprovalRequest & {
  status: "pending" | "submitting" | ToolApprovalOutcome;
  error?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseToolApprovalRequest(value: unknown): ToolApprovalRequest | null {
  if (!isObject(value) || value.type !== "tool-approval-request") return null;
  if (typeof value.approval_id !== "string" || typeof value.turn_id !== "string"
      || typeof value.server !== "string" || typeof value.tool !== "string"
      || typeof value.title !== "string" || typeof value.description !== "string"
      || typeof value.message !== "string" || typeof value.expires_at !== "number"
      || !Number.isInteger(value.expires_at) || !Array.isArray(value.parameters)
      || value.parameters.length > 20) return null;
  const parameters: ToolApprovalParameter[] = [];
  for (const parameter of value.parameters) {
    if (!isObject(parameter) || typeof parameter.name !== "string"
        || typeof parameter.display_name !== "string" || typeof parameter.value !== "string") return null;
    parameters.push({
      name: parameter.name,
      display_name: parameter.display_name,
      value: parameter.value,
    });
  }
  return {
    type: "tool-approval-request",
    approval_id: value.approval_id,
    turn_id: value.turn_id,
    server: value.server,
    tool: value.tool,
    title: value.title,
    description: value.description,
    message: value.message,
    parameters,
    expires_at: value.expires_at,
  };
}

export function parseToolApprovalResolved(value: unknown): ToolApprovalResolved | null {
  if (!isObject(value) || value.type !== "tool-approval-resolved"
      || typeof value.approval_id !== "string" || typeof value.turn_id !== "string"
      || !["approved", "denied", "expired", "cancelled"].includes(String(value.outcome))) return null;
  return {
    type: "tool-approval-resolved",
    approval_id: value.approval_id,
    turn_id: value.turn_id,
    outcome: value.outcome as ToolApprovalOutcome,
  };
}
