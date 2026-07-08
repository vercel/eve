---
issue: https://github.com/vercel/eve/issues/460
status: proposed
last_updated: "2026-07-07"
---

# HITL approval resume: parked tool calls have no owned closure invariant

Covers #236, #460, #529, #533 — one failure family.

## The obligation

When eve parks a local tool call for approval, the transcript now contains an
assistant `tool-call` part with no `tool-result`. Providers treat that as a
hard contract on replay:

- Anthropic: `tool_use ids were found without tool_result blocks immediately
after: <id>` → 400 (#460, #529, #533)
- OpenAI Responses: `No tool output found for function call call_<id>` → 400
  (#236)

So a park creates an obligation: **this exact tool-call id must be closed by
exactly one terminal result — success, error, denied, or ignored — before any
later model request replays it.** The corrupted history is durable, so a
single missed closure kills the session permanently: every subsequent turn
rebuilds and resends the same unmatched `tool_use`.

## The problem: closure is scattered across four places and two owners

No single component owns that obligation. Closure logic is spread across the
resume path, the AI SDK's replay mechanics, the stream-capture path, and the
message-assembly ordering in the tool loop. Because the logic is decoupled,
the invariant is never stated and never checked — each seam holds only as
long as its neighbors behave.

### Seam 1: the deny arm closes in eve, the approve arm closes in the AI SDK

Denial is closed by eve, inline, at resume
(`packages/eve/src/harness/input-requests.ts`):

```ts
/*
 * On denial (explicit "deny" or auto-deny when the user continues
 * without responding), splice in the matching `execution-denied`
 * tool-result. AI SDK's `streamText` synthesizes this for the
 * current turn's `initialResponseMessages`, but that synthesis is
 * gated on the input messages' last entry being a tool message —
 * on subsequent turns (when a new user message is the tail of
 * history) the synthesis is skipped, ...
 */
if (!approved) {
  parts.push({
    output: { type: "execution-denied", reason },
    toolCallId: request.action.callId,
    ...
```

Approval is closed by nobody in eve. `resolvePendingInput` appends a
`tool-approval-response` part and _relies on the AI SDK_ to notice it,
execute the tool, and emit the real `tool-result`. The comment above already
documents that the SDK's synthesis is conditional — eve patched the deny arm
around that condition and left the approve arm depending on it.

### Seam 2: the SDK's approve arm is gated on an undocumented tail scan

The dependency is `collectToolApprovals` (`ai`, `dist/index.js`), which only
inspects the final message of the assembled request:

```js
function collectToolApprovals({ messages }) {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role != "tool") {
    return { approvedToolApprovals: [], deniedToolApprovals: [] };
  }
  ...
```

If anything follows the approval tool message, the SDK silently executes
nothing — no error, no warning. The approved call's `tool_use` is then
persisted into durable history without a result, and the provider replay 400s
on the same or the next turn. For local tools the `tool-approval-response`
part itself is _not_ a provider-level closure: `ai` strips it before prompt
conversion (OpenAI Chat skips it; Anthropic `continue`s over it), so nothing
downstream compensates.

### Seam 3: eve protects that tail precondition for `message` but not `context`

eve half-knows about the precondition. `resolvePendingInput` defers a
follow-up user message so the approval message stays the request tail:

```ts
// AI SDK cannot process tool-approval responses and a new user message
// in the same request. Defer the message so the approval is resolved in
// isolation; `consumeDeferredStepInput` replays it on the next step.
```

But channel `context` is exempt from that deferral. `executeStepBody`
(`packages/eve/src/harness/tool-loop.ts`) appends it _after_ the resolved
approval messages:

```ts
if (stepInput.input?.context !== undefined) {
  for (const entry of stepInput.input.context) {
    messages.push({ content: entry, role: "user" });
  }
}
```

The precondition (seam 2) and its protection (seam 3) live in different
modules, so they drifted: the Linear channel sends `context` on every prompt,
including the one answering an approval, and every Linear approval breaks the
tail and kills the session (#529). Any channel or client that passes
`clientContext` with an approval response hits the same seam.

### Seam 4: the approved result reaches durable history only via stream capture

Even when the SDK does execute the approved tool, eve never appends the
result itself. The SDK emits it as `initialResponseMessages` stream parts,
and eve reassembles them from the stream
(`packages/eve/src/harness/tool-loop.ts`):

```ts
const { ..., inlineToolResultParts, trailingInlineToolResultParts } =
  await emitStreamContent(emit, emissionState, streamResult.fullStream, ...);
...
messages: insertInlineToolResultMessages({
  append: trailingInlineToolResultParts,
  prepend: inlineToolResultParts,
  responseMessages: stepResult.response.messages,
}),
```

Persistence of an obligation-closing result therefore depends on stream
capture inside the same model call that resumes the approval. #460 is the
observed failure of this seam: an approved slow tool's side effect ran
(verified in the external system), a second auto-approved (`once()`) call to
the same tool completed, and the _first_ call's `tool_result` still never
made it into durable history — the next turn 400s on that first, approved
call's id, forever.

### Seam 5: nothing guards the invariant at request-assembly time

There is no point in the harness that scans an outbound request for a local
`tool-call` without a matching `tool-result` and refuses (or repairs) it.
When any of seams 1–4 misbehaves, the corrupted transcript is sent verbatim,
the provider rejects it, and — because history is durable and append-only —
the session can never recover (#533). The 400 is produced by the provider,
not by eve, on a transcript eve assembled.

## How each issue falls out of a specific seam

| issue | seam | trigger                                                                                         | provider failure                                                 |
| ----- | ---- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| #236  | 2, 5 | approve-resume on OpenAI Responses; approval-response is not a closure for local function calls | `No tool output found for function call`                         |
| #460  | 4, 5 | approved `once()` tool with slow async `execute`, second auto-approved call same turn           | `tool_use ids ... without tool_result` on the _next_ turn        |
| #529  | 3, 2 | channel `context` on the approving prompt breaks the tail scan                                  | `tool_use ids ... without tool_result`, session permanently dead |
| #533  | 5    | replay of history carrying an approval-parked call                                              | `tool_use ids ... without tool_result` → `session.failed`        |

## Why point fixes keep failing

Each prior fix patched one seam without owning the obligation:

- `28e8ecc9` (#7) — surfaced denied approvals as rejected `action.result`
  events (observability arm only).
- 0.15.x — synthesized the deny-side `tool-result` so OpenAI stopped 400ing
  on denials (seam 1, deny arm only).
- `8713a71a` (#373) — "repair resume contract": deferred the follow-up
  _message_ to keep the approval message the tail (seam 3, `message` only —
  `context` was missed).
- `bd287b17` (#576) — spliced synthetic results for invalid-input tool calls
  (a sibling obligation, closed in yet another place).

The pattern is the diagnosis: every fix adds one more closure site, in a
different module, guarding one more entry point. The invariant — one terminal
result per parked call before any replay — still exists nowhere in code, so
each new entry point (a channel adding context, a slower `execute`, a
stricter provider) breaks it again.

## Direction

Centralize both halves of the obligation in the harness:

1. **One closure moment.** eve closes every parked local tool call itself at
   resume — executing approved tools directly (the execution wrapper already
   exists: `wrapToolExecute` in `harness/tools.ts`) and appending the durable
   `tool-result`/`tool-error` alongside the existing denial synthesis. No
   dependency on the SDK's tail scan or on stream capture for
   obligation-closing results. This also removes the reason the
   message/context deferral machinery exists.
2. **One guard.** A single pure reconciliation pass over the assembled
   messages, immediately before every model call: no local `tool-call`
   without a terminal `tool-result` may reach the wire. Dangling calls are
   closed with a synthetic error result and a warning — which also heals
   sessions already poisoned by earlier versions.

Detailed design lands with the solution PR.

## Sequencing

1. **PR 1 (this doc): one red e2e eval per issue.** Each encodes the issue's
   reported repro as closely as `eve eval` allows and must fail on current
   `main`:
   - #236 — `e2e/fixtures/agent-tools-hitl-openai/evals/hitl/approve-resume.eval.ts`
     (new fixture: same gated tool, `openai/gpt-5.5`)
   - #460 — `e2e/fixtures/agent-tools-hitl/evals/hitl/slow-once-approve-replay.eval.ts`
     (new slow `once()` fixture tool, two sequential calls, follow-up turn)
   - #529 — `e2e/fixtures/agent-tools-hitl/evals/hitl/approve-with-client-context.eval.ts`
     (`clientContext` rides the approving send — the channel-agnostic form of
     Linear's per-prompt context)
   - #533 — `e2e/fixtures/agent-tools-hitl/evals/hitl/dynamic-approve-then-followup.eval.ts`
     (dynamic always-gated tool, approve, then a follow-up turn that replays
     the transcript)
2. **PR 2 (stacked): the fix**, turning all four green without touching the
   evals.
