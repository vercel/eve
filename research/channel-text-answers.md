---
issue: TBD
status: implemented
last_updated: "2026-11-03"
---

# Channel text answers

> **AI status:** Written entirely by AI; human review pending.

A channel outside the `eve` package can't answer a pending approval or question from text as
eve's own channels do. Two pieces are missing from the public API: a way to say what the person
typed when the model reads a wrapped message, and the request a typed reply answers. Everything
else a text channel needs is ordinary code it can write itself, or that eve's first-party channel
packages share through a private subpath.

## Authoring API

`answerText` on `from(address).send()` options and on the `deliver` payload, from `eve/channels`:

```ts
await from(threadId).send(`${author}: ${text}`, { answerText: text, auth });
```

A pending request resolves against `answerText` instead of `message`, and the model reads
`message` unchanged. A `deliver` hook reads `payload.answerText` and may return a replacement
that changes it; a replacement without one keeps the delivery's. Empty text answers nothing.
Without `answerText`, a plain string `message` is the text, as before.

`nextPrompt(view)` from `eve/events`:

```ts
const prompt = nextPrompt(view); // Interaction | undefined
```

It returns the open request a typed reply answers now: a budget prompt first, then the oldest
request with no answer waiting. The harness resolves typed replies with the same function, so a
channel that shows this request alone shows the one a reply answers.

## Private channel helpers

`eve/internal/channels` re-exports what eve's channels share for showing a session as text:
replies and failure notices, one-at-a-time prompts, private sign-ins, the step's context, the
logger, and callback URL resolution. It is not documented or covered by `public-api/`, and it
changes with eve. A package that imports it, such as `@eve/recall`, releases with eve.

## Boundaries

- Slack moves to `answerText`, the only channel that set the text before.
- The internal input-text carrier stays the wire format; `answerText` is the public name for it.
- Exporting the shared helpers publicly, such as a text-surface toolkit for third-party
  channels, is out of scope. Promote a helper when an outside channel needs it.
