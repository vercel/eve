---
"eve": patch
---

v27 deployments now serve a session recorded by an earlier eve as v27 lines instead of answering `409 session_version_unsupported`, so v27 clients and `sessions.attach().stream()` render its history: messages, reasoning, tool calls, approvals, questions, sign-ins, subagents, clears, and compactions. Applications that saved events before the upgrade can convert them once with `convertLegacyEvents` from `eve/internal/legacy-events`, a temporary migration aid.
