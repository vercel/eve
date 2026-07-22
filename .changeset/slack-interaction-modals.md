---
"eve": patch
---

Slack channels can now open and receive their own modals. `SlackInteractionAction` gains `triggerId` (the payload's `trigger_id`, valid ~3 seconds, required for `views.open`), and a new optional `onViewSubmission` hook receives any `view_submission` whose `callback_id` is not the framework's HITL freeform modal — previously those were acked and dropped. Slack sends no channel or thread on view submissions, so stash routing context in `private_metadata` when opening the modal and read it back from the forwarded `SlackViewSubmission`.
