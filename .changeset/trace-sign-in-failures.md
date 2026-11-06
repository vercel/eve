---
"eve": patch
"@vercel/agent-runs": patch
---

Make connection sign-ins countable in traces: each sign-in span names its agent, a failed sign-in records its reason, and a call a connection refused records which connection and why.

`agent.approval` spans now carry `gen_ai.agent.name` and `agent.name`, so a query scoped to one agent no longer drops its sign-in prompts. A sign-in that fails with a reason code such as `access_denied` records it as `agent.connection.authorization.reason`; a sign-in that ends any other way, such as one a new message withdrew, records none. A tool call that fails with `ConnectionAuthorizationFailedError`, including one that never asked anyone to sign in, such as `principal_required` or `sign_in_unavailable` in a turn a schedule started, records `eve.connection.name` and `agent.connection.authorization.reason` on its `execute_tool` span. Only reason codes are recorded: a free-text reason or error message stays off the span whatever the trace policy records.
