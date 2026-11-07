---
"eve": minor
---

Add `label: false` to keep a tool's calls out of activity, such as emoji reactions.

Channels show no status for these calls, and a call doesn't end a quiet turn's silence, so a deferred Slack turn that only reacts and ends with `no_reply` stays silent. The call's `capability` and its message part from `eve/react`, `eve/vue`, and `eve/svelte` carry `hidden: true`, and `showsActivity(call)` from `eve/events` applies the same rule in custom renderers.
