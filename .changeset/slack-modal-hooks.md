---
"eve": minor
---

Slack apps can now handle their own Block Kit modals with `onView`: a `"submit"` event carries the submitted values and can return field errors or a replacement view, and a `"close"` event reports a person closing the modal.

Before this, `slackChannel` closed custom modals without delivering their data. Submission responses use Chat SDK's modal response actions. Existing `onInteraction` handlers and eve's **Type your answer** modal are unchanged.

Thanks @benpankow for the interaction design in #2922 that this builds on.
