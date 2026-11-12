---
issue: https://github.com/vercel/eve/issues/5914
status: implemented
last_updated: "2026-11-12"
---

# Empty reply retry

A provider sometimes ends a turn with `finishReason: "stop"` and nothing in it:
no text, no tool calls. A root session accepts that as the turn's answer
(#4917), so an agent can stay quiet. An agent that never means to be silent
can't tell a provider glitch from a choice, and its user gets a turn that ended
without a reply.

## Authoring API

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  emptyReply: "retry", // default "accept"
});
```

- `"accept"` (default): today's behavior. A root session completes the turn
  without a final message.
- `"retry"`: a root session treats an empty `stop` the way a delegated session
  already does. eve reissues the model call once with the existing empty-reply
  note, and fails the turn with `MODEL_CALL_FAILED` if the second reply is also
  empty. The agent stays quiet on purpose with `no_reply`.

Delegated sessions always retry, because their caller needs a reply, so the
option only changes root sessions, scheduled runs included. A dynamic subagent
config can carry the field, but it changes nothing there.

## Semantics

No new retry path. The model caller's usable-response check already throws
`EmptyModelResponseError` for an empty `stop` when it does not accept empty
replies. The existing recovery reissues the call once with the note, and a
second empty reply fails the turn as it does for a delegated session. The option
only decides whether a root session accepts the empty `stop`.
