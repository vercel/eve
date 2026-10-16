---
issue: https://github.com/vercel/eve/issues/4754
status: proposed
last_updated: "2026-10-14"
---

# Turn replies

## Summary

A turn can send the person more than one reply. In a root session, the model can reply, wait on
its tasks, and reply again, and Slack posts both replies. The turn result reports only one of them.
On `main`, `send().result()`, eval turns, and MCP `agent_get` reduce a turn to one `message`
string: the reply written before a task wait is cleared, and the last reply wins. When the resumed
turn writes nothing more, for example after a `no_reply` tool call, the result has no reply at
all, although the person read one (#4754).

Keeping the last reply (#4756) still drops the reply written before the wait whenever both exist.
Joining every reply into one string keeps the text but not the replies: a reply can itself contain
a blank line, so a joined string cannot be split back into what the person received. Evals,
judges, and publishers must see the replies as they were sent.

This proposal replaces the single `message` string with `replies`: every reply, in order, as a
record that keeps the reply's text and why it ended.

## Current behavior on `main`

| Surface                      | Field                          | Holds                                      |
| ---------------------------- | ------------------------------ | ------------------------------------------ |
| `send().result()`            | `message: string \| undefined` | last reply after the latest `turn.waiting` |
| eval turn                    | `message: string \| undefined` | same                                       |
| eval task result             | `finalMessage: string \| null` | last turn's `message`                      |
| eval task result             | `output: unknown`              | `data`, else `finalMessage`                |
| `t.judge()` without `on`     | `output`                       | last turn's `message`                      |
| `eve invoke` JSON            | `outcome.message`              | same                                       |
| MCP `agent_start/get/update` | `result?: JsonValue`           | same, always a string                      |
| `ctx.agent(...).result()`    | `message: string \| undefined` | the child turn's task output, if a string  |

A reply is a `message.completed` whose `finishReason` is not `"tool-calls"`. Text written before a
tool call in the same step is `"tool-calls"` narration. Child and schedule sessions also report
text written before a task wait as `"tool-calls"`. Root sessions report it as a reply, and
channels post it.

## Proposed API

```ts
/** One reply the agent sent the person in a turn. Tool-call narration is not a reply. */
export interface Reply {
  readonly text: string;
  /** Why the reply ended. `"length"` marks a reply cut off by the output limit. */
  readonly finishReason: Exclude<AssistantStepFinishReason, "tool-calls" | "content-filter">;
}
```

| Surface                        | Field                                     |
| ------------------------------ | ----------------------------------------- |
| `send().result()`, `respond()` | `replies: readonly Reply[]`               |
| eval turn                      | `replies: readonly Reply[]`               |
| eval task result               | `finalReplies: readonly Reply[]`          |
| eval task result               | `output: data ?? null`                    |
| `t.judge()` without `on`       | `output: renderReplies(lastTurn.replies)` |
| `eve invoke` JSON              | `outcome.replies`                         |
| MCP `agent_start/get/update`   | `replies: Reply[]`                        |
| `ctx.agent(...).result()`      | `replies: readonly Reply[]`               |

`message`, `finalMessage`, and MCP `result` are removed on every surface. The list is the data.

`renderReplies(replies)` from `eve/evals` is the one text rendering: the texts in order, separated
by a blank line. It exists for prose consumers such as judges. `t.judge()` uses it by default, and
an author passes it explicitly to `state`.

`output` holds only structured `data`. A reporter that logged the reply text reads
`finalReplies`.

MCP callers get the same records as every other surface. A calling model can tell a cut-off reply
from a complete one, and one shape keeps the client, evals, and MCP in step.

## Semantics

- **Order.** `replies` lists replies in the order their `message.completed` events were emitted.
- **Scope.** `replies` holds the replies of the events one response read, not the whole turn.
  `result()` that stops at a question carries the replies written before it. `respond()` carries
  only the replies written after the answer, so `finalReplies` is `[]` when the answered turn
  writes nothing more.
- **Silent turns.** A turn that writes no reply reports `replies: []`. Replies never carry over
  from an earlier turn.
- **In progress.** MCP `working`, `input_required`, and `authorization_required` carry the replies
  written so far.
- **Cut-off and superseded replies.** A reply ended by the output limit stays in `replies` with
  `finishReason: "length"`, so an eval can fail a truncated answer. A step superseded by a steering
  message ends with `"other"`; channels post its text, so it is a reply. A content-filtered step
  emits no `message.completed` and never becomes a reply.
- **Structured output.** `data` stays separate. `replies` never holds schema-validated output.

## Eval authoring

A root session's agent replies, waits on a forecast task, and replies again with the result:

```ts
const turn = await t.send("What's the weather in Paris?");

turn.replyIncludes("Sunny"); // any reply's text
t.check(
  turn.replies.map((reply) => reply.text),
  equals(["Checking the forecast; I'll report back.", "Sunny, 72F"]),
);
t.check(turn.replies.at(-1)?.finishReason, equals("stop"));

t.judge({ state: { response: renderReplies(turn.replies), reference }, questions });
```

Exact checks compare the list, so a test fails when the agent splits or merges replies.

`messageIncludes` becomes `replyIncludes` and reads only `replies`. Today it matches every
`message.completed`, including tool-call narration. This is a breaking change: an eval that asserts
on narration matches the event instead, with `turn.event("message.completed", { data: { message } })`.

## Child agent replies

A child's reply reaches a `ctx.agent` caller as its settled turn's `output`, one JSON value. The
same `output` is the tool result the parent model sees. The settled turn gains `replies`, next to
`output`, on its way to the caller:

```text
child turn settles ── output ───▶ parent model's tool result (unchanged)
                  └── replies ──▶ ctx.agent(...).result().replies
```

A child reports held text as narration, so its turn has at most one reply, and the gain is that
reply's `finishReason` plus one result shape across surfaces. The cost is a new field through the
child's settled turn, the parent notification, and the subagent result, a durable payload. It is
implemented last, after the other surfaces.

## Prior art

- [LangChain agents](https://docs.langchain.com/oss/python/langchain/agents) return
  `result["messages"]`: every human, AI, and tool message, each AI message with a `finish_reason`.
- [AI SDK `generateText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text) returns
  `steps`, including tool-call steps, each with its text and `finishReason`. Its top-level `text`
  is the final step only.

Both keep records with a finish reason, and neither joins replies. Both lists also include
non-replies; eve already exposes the full record as `events`. `replies` is the narrower view of
what the person received. The AI SDK's convenience `text` keeps the last step only, which is the
behavior this proposal removes.

## Scope

- Stream events, channel delivery, Slack rendering, and the model-visible tool result of an agent
  call are unchanged.
