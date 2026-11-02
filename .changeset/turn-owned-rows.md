---
"eve": patch
---

Session events can now record a call or a content part that its turn made without a model run: `call.requested` accepts an `owner` of `{ turnId }`, and `content.completed` names a `turnId` instead of a `runId`.

The fold, the client's conversation, and the Slack channel place both under their turn. `ContentCompletedData.runId` and `CallOwner` are wider in TypeScript, so code that reads `runId` as always present or switches over owners needs a default branch. Stream version 27 also now allows a later release to add owners, and a reader treats a row whose owner it doesn't know as the session's.
