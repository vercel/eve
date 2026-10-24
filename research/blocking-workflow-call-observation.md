---
issue: https://github.com/vercel/eve/pull/4975
status: implemented
last_updated: "2026-10-21"
---

# Blocking workflow call observation

A workflow tool's `execute` runs outside the session's durable turn step, but its call blocks the turn. Unlike `task` and `serve`, it creates no task. Without a stream distinction, `waiting(view, turnId)` mistakes that running call for inline work and reports `session` while the coordinator actually waits for an external result.

Preserve the additive fact proposed in #4975:

```ts
interface CallStartedData {
  // Existing fields are unchanged.
  readonly workflow?: true;
}
```

The dispatch receipt sets this field only for blocking workflow execution. The fold retains it on the call, and the waiting selector excludes it from inline work. Running model work, pending response-policy work, and unanswered interactions retain their existing priority. Task-backed calls retain `taskId`; no artificial task is introduced.

This is an optional v27 stream field, not a new engine-authoring API or a change to `interaction` waiting vocabulary. Older readers tolerate the field but do not gain the corrected waiting classification. The restored real-harness explorer reproduces the misclassification without the selector/receipt distinction. The cancellation fixture checks the real Workflow path in CI.
