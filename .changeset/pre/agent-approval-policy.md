---
"eve": minor
---

Set `approval` in `agent.ts` to gate every tool, connection, and subagent call from one policy.

The agent's policy runs beside each entry's own `approval` and the stricter result wins, so it can add a gate but never remove one. Subagent sessions inherit the root agent's policy. Thanks @kingztech2019 and @taoufik-ia for the proposals in #145 and #2673.
