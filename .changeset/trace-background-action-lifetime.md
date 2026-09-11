---
"eve": patch
---

Keep `agent.action` spans for background tools and subagents open until their tasks complete, fail, or are cancelled, and record the task's final outcome and policy-controlled error details instead of treating its receipt as completion.
