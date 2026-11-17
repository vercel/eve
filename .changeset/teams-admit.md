---
"eve": minor
---

Teams agents now ignore conversations that include another Microsoft Entra tenant, and guest and anonymous accounts, by default, and a new `teamsChannel({ admit })` hook decides who may reach the agent on every Teams surface.

`admit` runs before `onMessage`, `onAnswers`, and `onInvoke`, covering messages, approval and question card answers, and **Sign in** presses, and before `receive` starts a session in a conversation. The default, `defaultTeamsAdmit`, refuses conversations in a tenant other than `credentials.tenantId` when one is set, channels Teams marks as shared, senders whose conversation membership reports another tenant or a `guest` or `anonymous` role, and conversations and senders Teams can't classify. It looks each sender up with the Bot Connector's conversation member API and caches the answer briefly.

Proactive `receive` targets now need `tenantId`. To keep serving other tenants or guests, pass `admit: () => true`, or call `defaultTeamsAdmit` from your own policy.
