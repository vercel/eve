---
"eve": minor
---

Slack apps can now handle their own Block Kit modals: `onModalSubmit` receives a modal's submitted values and can return field errors or a replacement view, and `onModalClose` runs when a person closes it.

Before this, `slackChannel` closed custom modals without delivering their data. Both hooks follow Chat SDK's `onModalSubmit` and `onModalClose`. Existing `onInteraction` handlers and eve's **Type your answer** modal are unchanged.

Thanks @benpankow for the interaction design in #2922 that this builds on.
