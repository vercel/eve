---
"eve": minor
---

Publish tasks, interactions, responses, controls, and child sessions as v27 session facts.

- **Tasks.** A task run publishes `task.started` once and `task.ended` when its run ends. Each call it serves publishes `call.started` with the task id and settles on its own reply; calls that share a reply reference the first call's output. The 32-task working limit is read from the shared tables. A refusal now states its cause (`task-limit` or `task-unavailable`). Spend that a task reports after its calls have settled is recorded as task-scoped `delegated-late` usage before `task.ended`.
- **Call outcomes.** A call fails only when its result sets `isError`. Successful output that looks like an error stays a success, and rejection is explicit.
- **Interactions and responses.** Approvals, questions, budget prompts, and sign-ins are interactions, and answers are responses tied to the delivery they arrived in:
  - Answers keep one identity through coalescing and policy checks.
  - An answer to an approval batch can be revised until the batch is decided. The deciding answers then apply in one commit, beside the rejected calls.
  - A budget prompt pauses its turn instead of ending it.
  - A sign-in callback is a `callback` delivery whose response has no value. The provider payload stays private.
  - A call a person approved starts with `clearedBy: { interactionId }` when it runs, after the approval policy rechecks it.
- **Controls.** `cancel`, `clear`, `compact`, and `reset` arrive as deliveries with their own ids. `Session`, channel addresses, and channel sources accept an optional `{ auth }` to name the sender, and the HTTP control routes pass the caller's auth. A cancelled turn and a reset session name the control's delivery as their cause.
- **Child sessions.** `child.opened` replaces `agent.started`. A remote child's deployment binding is private: only the parent's stream proxy reads it. The remote agent protocol moves to 3. A remote agent still serves callers on protocols 1 and 2 their results and failures, but relays no approvals, questions, or sign-ins to them: a turn that needs one fails and names the upgrade. A parent follows only a protocol-3 child's live stream; an earlier child's result still arrives. The eval `remoteUrl` field and matcher are removed.
- **Handoff.** Session checkpoints move to version 15. A session started on an earlier build continues on the deployment that owns it, because its stream uses the earlier event shape.
- **Development checks.** Under `eve dev`, each written line is checked against the event contract, and a violation fails the publication. Set `EVE_CHECK_SESSION_EVENTS=0` to turn the check off, or `=1` to turn it on elsewhere.
- **Breaking changes.** The v26 input, approval, authorization, task, and `agent.started` events are removed. Hook and channel keys that name them fail with their replacement. Hook (46), channel (59), and schedule (32) extensions built for earlier epochs must be rebuilt; tool epoch 87 still accepts 86.
