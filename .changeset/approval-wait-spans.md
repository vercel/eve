---
"eve": minor
"@vercel/agent-runs": minor
---

Record an `agent.approval` span for every wait on a person, including questions, budget prompts, and connection sign-ins, not just tool approvals.

`agent.approval.kind` is `tool-approval`, `question`, `budget`, or `sign-in`. A wait sits under the tool call it's about, or under the turn when no call owns it, and a sign-in names its connection in `eve.connection.name`. Instrumentation providers now receive sign-ins on `interaction.opened` and `interaction.settled`, with `signIn.name` naming the connection or tool; the sign-in URL and code stay out of the event. `@vercel/agent-runs` adds `TurnOperation.approval` and `findApproval`, and an optional `kind` and `connectionName` on approvals.
