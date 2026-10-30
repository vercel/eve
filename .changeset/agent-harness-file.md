---
"eve": patch
---

Add an experimental `agent/harness.ts`, whose `defineHarness((ctx) => ({ agent, history, next }))` from `eve/experimental/harness` decides how the agent's turns run.

`agent` sets the model, tools, and instructions each model call gets, as whole sets the harness composes from `declared(ctx)`, what the agent's files declare, and `builtins(ctx)`, eve's own tools and prompt renderers. `history` runs before every model call and for `session.compact()`, and what it returns becomes the session's history. `next` runs before and after each model call: it can continue the turn with a note, settle it without the model, or fail it with its own message.

The model's answers under a harness are drafts until it settles. Every text part's first `content.delta` carries `draft: true`, and a part the harness doesn't keep completes with phase `"draft"`. Slack, Linear, Chat SDK channels, eve's client, and the ACP server hold that text until it completes and never show drafts.

The new Harness page documents it.
