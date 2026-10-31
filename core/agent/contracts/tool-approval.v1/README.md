# tool-approval.v1

The owner-scoped request, response, and result messages for one gated MCP tool call. Requests are
published on the owning chat unit's output stream; the terminal can approve or deny them through the
authenticated chat API. A missing, expired, malformed, or unmatched response is always a denial.

Approval is per call only. This contract has no "always allow" action and does not carry credentials.
Parameter values are bounded display strings and must be redacted before publication when their names
look credential-like.
