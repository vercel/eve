# @eve/json-render

An eve extension that answers with [json-render](https://json-render.dev) cards. It contributes:

- a `card` tool whose `replyPart` adds the model's json-render spec to the turn's reply, rejecting specs that break Slack's per-message limits so the model can fix them;
- a content renderer for `application/vnd.json-render.card+json`, which Slack and Chat SDK channels post natively and preview while the model writes the spec;
- instructions for when to use a card.

Cards use json-render's chat components except `Button`: nothing on a card reaches the agent, so links go in a `LinkButton`.

## Mount

```ts
// agent/extensions/cards.ts
export { default } from "@eve/json-render";
```

See [`examples/json-render-slack`](../../examples/json-render-slack) for an agent that uses it.
