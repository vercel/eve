---
"eve": patch
---

eve now writes Slack task cards in separate workflow steps, outside the turn, so slow Slack calls no longer hold up the agent, and several changes in a row become one write. A renderer's `taskCard` is async and can await `task.agent.work()` for an agent task's own tool calls, with the same titles and statuses as the card's rows; eve reads the agent's session only when a card asks. `slackChannel({ taskCards: { refreshIntervalMs } })` renders such cards on an interval while those agents work.
