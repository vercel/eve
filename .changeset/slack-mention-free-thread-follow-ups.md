---
"eve": minor
---

Add an opt-in `followUps` option to the Slack channel so the agent keeps answering plain (non-mention) replies in threads it is already part of, without a re-`@mention`. Pass `followUps: true` for the built-in "answer in threads I'm part of" rule, or `followUps: { decide }` to layer an agent-specific check on top.
