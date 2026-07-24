---
"eve": patch
---

A model step that requests a tool approval (or question) and a subagent or remote-agent call in the same response no longer drops the approval. The harness now parks on both: the input request surfaces immediately, the delegation runs, and when its result arrives the turn re-parks on the still-pending approval instead of calling the model with a dangling tool call (`AI_MissingToolResultsError`).
