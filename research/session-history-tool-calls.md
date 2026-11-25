---
issue: https://github.com/vercel/eve/issues/5340
status: in-progress
last_updated: "2026-11-25"
---

# Tool calls in session history

> **AI status:** Written entirely by AI; human review pending.

## Summary

Session `history` (#4477) takes user and assistant text only. A conversation that used tools
loses them on import: the app flattens results into prose, or the model reads an answer with no
evidence behind it. #5340 asks for completed tool exchanges, and eval authors need the same
thing to grade a reply against a conversation where the agent already looked something up.

This plan adds completed tool calls to assistant history entries. It covers the tool half of
#5340. Files stay out.

## Authoring API

```ts
const history: SessionHistoryMessage[] = [
  { role: "user", text: "Is ticket T-1 still open?" },
  {
    role: "assistant",
    text: "T-1 is open, but its notes didn't load.",
    toolCalls: [
      { name: "lookup_ticket", input: { id: "T-1" }, output: { status: "open" } },
      { name: "list_notes", input: { id: "T-1" }, error: "The notes service timed out." },
    ],
  },
];
```

```ts
/** One completed tool call on an assistant history message. */
export interface SessionHistoryToolCall {
  readonly name: string;
  /** Defaults to `{}`. */
  readonly input?: JsonValue;
  /** The JSON value the model reads as the result. Exactly one of `output` or `error`. */
  readonly output?: JsonValue;
  /** The message the model reads as a failed call's error result. */
  readonly error?: string;
}
```

`SessionHistoryMessage` gains `toolCalls?`. `text` stays required, so every existing entry and
reader keeps working. The option applies wherever `history` does: `create()`, `send()`, every
channel's message hook, and `t.session({ history })`.

A call carries its own result, so a call without a result, or a result without a call, can't be
written. That is the reason for this shape over separate call and result parts.

## Semantics

- **Order.** The model reads an entry as one assistant step with its calls, one tool message with
  their results, then the entry's `text` as the reply. Several steps are several assistant
  entries.
- **Data, not execution.** eve runs no tool, approval, hook, or `toModelOutput`. A string `output`
  becomes a text result, any other JSON a JSON result, and `error` an error result.
- **What eve checks.** The shape: a non-empty `name`, JSON `input` and `output`, exactly one of
  `output` or `error`, calls only on assistant entries, and no other field. A pending call or an
  approval has no field to go in, so it is rejected.
- **What eve does not check.** `name` against the agent's tools, and `output` against a tool's
  schema. An agent's tools can change per turn, and a stored conversation may name tools the
  agent no longer has. The app that supplies history owns that.
- **Call ids.** eve gives each call an id of the form `imported_<n>`, numbered after the imported
  calls already in the session's model history. The ids appear only in model history.
- **Stream.** `delivery.consumed` history records `toolCalls` as supplied. There are no `call.*`
  events, usage, or call rows, so selectors, `t.calledTool()`, and traces count only calls eve
  ran.
- **Display.** Frontend `messages` and `transcriptOf()` keep showing an imported entry's text.
  An app that wants to show the calls reads them from `delivery.consumed`.
- **Permission.** A client request still needs `allowHistoryImport`. The grant now also lets its
  holder supply tool results, which the auth guide states.

## Non-goals

- Files, reasoning, and provider-specific parts in history.
- Calls that are pending, awaiting approval, or provider-executed.
- Tool parts for imported calls in frontend `messages`.
- Caps on the count or size of entries. As with text history, the app trims what it loads.

## Validation

- Unit: accepted and rejected shapes, and the eve channel create route.
- Integration: prompt order, result types, call ids across two imports, no `call.*` events, and
  the interrupted-step recovery path.
- E2E: an eval starts a session from history with a completed and a failed call, the agent
  answers from both, no tool runs, and a call without a result is rejected.
