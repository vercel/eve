---
issue: "None (requested by the v coding agent team at Vercel)"
status: implemented
last_updated: "2026-10-27"
---

# Thrown tool error type

## Summary

When a tool throws, its `execute_tool` span reads
`error.type: ACTION_RESULT_FAILED` whatever the tool threw. This plan sets
`error.type` to the thrown error's `name` when the call's error code is
`ACTION_RESULT_FAILED` and the name is not `Error`. A tool reports a failure
class by throwing a named error class. To reach traces that do not record
outputs, the `call.settled` instrumentation event gains an optional
`errorName`. `call.settled` in the session, the protocol, and the text the
model reads stay as they are.

## Problem

The v coding agent's `publish_pull_request` tool fails for two different
reasons: a Git credential broker refuses a token (an infrastructure fault), or
the user's request cannot be published (a user error). Its Datadog monitors
read `error.type` on `execute_tool` spans, and both failures arrive as
`ACTION_RESULT_FAILED`.

eve 0.84.1 and `main` map thrown errors as follows. The model receives
`error.toString()`, that is `name: message`, which the AI SDK and
[`call-executor.ts`](../packages/eve/src/harness/call-executor.ts) both
produce.

| Thrown value                                                      | `call.settled.error`                                                                  | Span `error.type`      | Model receives                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------- |
| `new Error("refused")`                                            | `{ code: "ACTION_RESULT_FAILED", message: "refused", name: "Error" }`                 | `ACTION_RESULT_FAILED` | `Error: refused`                             |
| `new GitBrokerRefusedError("refused")`                            | `{ code: "ACTION_RESULT_FAILED", message: "refused", name: "GitBrokerRefusedError" }` | `ACTION_RESULT_FAILED` | `GitBrokerRefusedError: refused`             |
| `Object.assign(new Error("refused"), { code: "E_REFUSED" })`      | `{ code: "ACTION_RESULT_FAILED", message: "refused", name: "Error" }`                 | `ACTION_RESULT_FAILED` | `Error: refused`                             |
| `new Error(JSON.stringify({ code: "X", message: "human text" }))` | `{ code: "X", message: "human text", name: "Error" }`                                 | `X`                    | `Error: {"code":"X","message":"human text"}` |

eve already keeps the name so that instrumentation can classify a failure:

- [`action-result-helpers.ts`](../packages/eve/src/harness/action-result-helpers.ts)
  records a thrown error's `name` as `errorName`, with the comment "its name
  lets instrumentation classify the failure" (#4826).
- [`native-events.ts`](../packages/eve/src/instrumentation/native-events.ts)
  rebuilds the instrumentation error with `name: event.data.error.name`.
  [Instrumentation](../docs/guides/instrumentation/instrumentation.mdx) tells
  handlers to inspect `error.name`.
- The agent-runs tracer sets `error.type` to the error type it is given, else
  `error.name`, else `_OTHER`.
  [`agent-tool-instrumentation.ts`](../packages/eve/src/tracing/eve/agent-tool-instrumentation.ts)
  always passes `call.settled.error.code`, so for a thrown error the name
  never reaches `error.type`.

OpenTelemetry's `error.type` convention names the exception's class when an
exception ends the operation. #4421 removed `agent.action.error.code` as a
duplicate of `error.type`, so `error.type` is the attribute to fix.

## Existing code rules

`call.settled.error.code` comes from four rules:

1. A failed result whose output is a JSON object, or a JSON string, with string
   `code` and `message` takes that code
   ([`call-outcome.ts`](../packages/eve/src/harness/call-outcome.ts)).
2. eve writes such outputs for its own failures, for example
   `TOOL_EXECUTION_DENIED`
   ([`call-executor.ts`](../packages/eve/src/harness/call-executor.ts),
   documented in [Human-in-the-loop](../docs/tools/human-in-the-loop.md)).
3. A workflow tool failure whose serialized error has a string `code` keeps
   that object as its output, so rule 1 applies
   ([`owner-inbox.ts`](../packages/eve/src/execution/tools/workflow/owner-inbox.ts)).
4. Every other failure reads `ACTION_RESULT_FAILED`.

This plan adds no rule and changes none. It changes only the span's
`error.type` for calls that rule 4 settles.

## Decision: Option F

The tool span's error type when a call fails:

| `call.settled.error.code`                  | Thrown error name             | Span `error.type`      |
| ------------------------------------------ | ----------------------------- | ---------------------- |
| Anything other than `ACTION_RESULT_FAILED` | any                           | the code               |
| `ACTION_RESULT_FAILED`                     | non-empty, other than `Error` | the name               |
| `ACTION_RESULT_FAILED`                     | `Error`, empty, or absent     | `ACTION_RESULT_FAILED` |

A tool classifies a failure with an error class:

```ts title="agent/tools/publish_pull_request.ts"
class GitBrokerRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitBrokerRefusedError";
  }
}

throw new GitBrokerRefusedError("The Git credential broker refused a token for this repository.");
```

The mapping lives in `agent-tool-instrumentation.ts`. Option F adds no
authoring export, schema field, or marker, and `call.settled` in the session
is unchanged.

## Output-capture gap

The tool instrumentation sees the thrown error only through `event.error`.
[`native-events.ts`](../packages/eve/src/instrumentation/native-events.ts)
sets it to `line.capturesOutputs ? error : undefined`, and the type documents
it as "Content: absent unless this provider records outputs." `errorCode` is
the only failure field that reaches every trace. v's trace policy records
outputs only for public audiences and in development:

```ts title="agents/v/agent/instrumentation/otel.ts (vercel/api)"
tracePolicy: ({ audience, environment }) => ({
  emit: true,
  recordInputs: audience === "public" || environment === "development",
  recordOutputs: audience === "public" || environment === "development",
}),
```

Reading the name from `event.error` leaves every other production trace at
`ACTION_RESULT_FAILED`.

| Option                                                                                                                      | Cost                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1. Optional `errorName` on `InstrumentationCallSettledEvent`, set from the thrown error's name on every trace (chosen)** | Adds a field to a public event type. A tool that builds `name` from user data puts that text into traces that record no outputs. `call.settled` in the session record already carries the name. |
| F2. Read the name from `event.error`                                                                                        | No public type change. `error.type` depends on the trace's content policy, so a monitor sees the class on some traces and `ACTION_RESULT_FAILED` on others for the same failure.                |
| F3. F2, and v records outputs in production                                                                                 | v's spans carry tool outputs and error messages for every audience. v's exporter filters attributes, and every other eve consumer still hits the gap.                                           |

F1 treats the class name like `errorCode`: a classification field, not
content. The public type gains one field:

```diff
 /** The call settled: the session's `call.settled`, or a direct call's end. */
 export interface InstrumentationCallSettledEvent {
   readonly type: "call.settled";
   readonly outcome: InstrumentationCallOutcome;
   /** A completed call's output. Content: absent unless this provider records outputs. */
   readonly output?: unknown;
   /** Why it didn't complete. Content: absent unless this provider records outputs. */
   readonly error?: unknown;
   readonly errorCode?: string;
+  /** The thrown error's `name`, such as `"GitBrokerRefusedError"`, on every trace. */
+  readonly errorName?: string;
   readonly usage?: InstrumentationUsage;
```

`native-events.ts` sets `errorName: event.data.error?.name`, and
`agent-tool-instrumentation.ts` reads `event.errorName`. Direct `invokeTool`
calls publish neither `errorCode` nor `errorName`, and F1 leaves them
unchanged.

## Behavior change

For every eve consumer, with F1:

- Every tool that throws a named error gets that name as its span's
  `error.type`. Examples: `TypeError` (a failed `fetch` rejects with
  `TypeError: fetch failed`), `AbortError`, `TimeoutError`, `ZodError`, AI SDK
  errors such as `AI_APICallError`, and undici's `SocketError`.
- Node system errors such as `ECONNRESET` and `ENOENT` have `name: "Error"`
  and keep `ACTION_RESULT_FAILED`.
- Custom instrumentation providers receive `errorName` on `call.settled`
  events. Existing fields keep their values and content gating.
- `call.settled` in the session, the protocol, and the model's tool result are
  unchanged. No code in this repository outside the harness matches
  `ACTION_RESULT_FAILED`.
- A monitor that counts every thrown tool failure through
  `error.type:ACTION_RESULT_FAILED` needs to match
  `agent.action.outcome:failed`.
- Class names are low-cardinality, and the tracer truncates `error.type` to
  128 characters.
- A custom name survives eve's workflow serialization:
  `normalizeSerializableError` and `rebuildSerializableError` in
  [`workflow-errors.ts`](../packages/eve/src/execution/workflow-errors.ts) keep
  `name`. `structuredClone` resets a non-standard name to `Error`, and no
  tool-error path in eve uses it.

## Options considered

| Option                                                    | Status   | Cost                                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F. `error.type` from the thrown error's name**          | Chosen   | Changes `error.type` for every tool that throws a named error. No new authoring API. Needs F1 to reach traces that record no outputs.                                                                                                                     |
| A. Exported `ToolError` with a `code`                     | Rejected | Adds a fifth code rule. Reads like a terminal-error class, and [When a tool throws](../docs/tools/overview.mdx) states that authored tools have none. Its symbol marker does not survive workflow serialization. Adds a schema field and a public export. |
| B. Honor any string `code` on a thrown error              | Rejected | Library errors that reach a tool unhandled (`ECONNRESET`, undici `UND_ERR_*`) change `call.settled.error.code` for every eve agent, and the code comes from a dependency, not from the author.                                                            |
| C. Throw a JSON-object message (works today)              | Rejected | The model reads raw JSON prefixed with `Error: `, and `message` carries two meanings.                                                                                                                                                                     |
| D. Keep `ACTION_RESULT_FAILED`; add a separate code field | Rejected | A new field on `call.settled` and the instrumentation event, plus a span attribute that duplicates `error.type`, which #4421 removed.                                                                                                                     |
| E. Do nothing                                             | Rejected | Monitors cannot tell an infrastructure refusal from a user error.                                                                                                                                                                                         |

## Verification

- Unit,
  [`session-spans.test.ts`](../packages/eve/src/tracing/eve/session-spans.test.ts),
  which builds `call.settled` from a thrown error and runs the production OTel
  provider:
  - A failed call with `ACTION_RESULT_FAILED` and the name
    `GitBrokerRefusedError` sets `error.type` to `GitBrokerRefusedError`.
  - A plain `Error`, and a Node system error such as `ECONNRESET`, keep
    `ACTION_RESULT_FAILED`.
  - A failed call with an output-derived code, such as `X` from the
    JSON-message path, keeps that code, whatever its name.
  - Each case holds on traces with and without output recording.
- Unit,
  [`native-events.test.ts`](../packages/eve/src/instrumentation/native-events.test.ts):
  the `call.settled` instrumentation event carries `errorName` when outputs are
  not recorded and `error` is absent.

No e2e eval: e2e evals assert agent behavior over HTTP and do not read OTel
spans, and the change adds no authoring API.

## Rollout

- Docs: [OpenTelemetry](../docs/guides/instrumentation/otel.mdx) states that a
  thrown error's class name sets `error.type` when the call has no code of its
  own. [Instrumentation](../docs/guides/instrumentation/instrumentation.mdx)
  lists `errorName` beside `errorCode` on `call.settled`.
- A patch changeset for `eve`.
- After merge, the changeset joins the open "Version Packages" pull request.
  npm receives the release when a maintainer merges that pull request.
- v is on eve 0.84.1 through the vercel/api `pnpm-workspace.yaml` catalog.
  After the release, a one-line catalog bump in vercel/api picks up the
  change. v then throws a named error from `publish_pull_request` and points
  its monitors at `error.type:GitBrokerRefusedError`.
