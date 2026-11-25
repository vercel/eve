---
issue: https://github.com/vercel/eve/issues/5340
status: in-progress
last_updated: "2026-11-25"
---

# Finished tool calls in session history

> **AI status:** Written by AI; human review pending.

`history` on `send()`, `create()`, `ctx.to().send()`, and `onMessage` takes only `{ role, text }`,
so a conversation copied into a new session loses the tool calls it made. Apps that branch a
conversation (#5340) and `openCodeChannel` both flatten them into text. This extends the same
`history` rather than adding a seeding or fork API. Files stay a follow-up.

## Authoring API

An entry takes `parts` instead of `text`:

```ts
{ role: "assistant", parts: [
  { type: "tool", name: "roll_dice", input: { sides: 20 }, output: { rolls: [3] } },
  { type: "text", text: "Done." },
] }
```

- A user entry takes text parts only.
- A tool part has `name`, optional `input` and `callId`, and exactly one of `output` (any JSON)
  or `error` (a string). Calls still running, or waiting for approval, are not history.
- `callId` is unique within the history; eve assigns `history_<uuid>` when it is omitted.

## Semantics

- Imported calls are data. eve never runs them, checks them against the agent's tools, or calls
  `toModelOutput`; the app that supplies history authorizes it, as today.
- An assistant entry's parts become model steps in order: a run of calls becomes one assistant
  message and one tool message, and text after calls starts the next step.
- `output` is sent as JSON, or as text when it is a string; `error` is sent as error text.
- The stream records the entry on `delivery.consumed` with `parts` (each call with its `callId`)
  and `text` set to its text parts. `parts` is an optional field, so stream version 27 readers
  keep working; frontend messages show each call as a completed or failed tool part.
- `openCodeChannel` copies the thread's finished calls into the code channel's history.

Thanks to @FranciscoMoretti, whose implementation in his fork shaped this.
