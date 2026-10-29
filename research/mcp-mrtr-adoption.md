---
issue: https://github.com/vercel/eve/issues/4159
status: proposed
last_updated: "2026-10-29"
---

# Adopt MCP multi-round-trip requests in eve

## Outcome and existing work

An MCP tool that needs information from a person should hold the calling eve
turn, show the question in its channel, and continue when that person answers.
For example, a Connect deployment event could trigger an investigation whose
rollback tool asks which deployment to restore. The event starts the work; MCP
multi-round-trip requests (MRTR) carry the tool's question and answer.

This plan covers the client portion of [#4159](https://github.com/vercel/eve/issues/4159).
It builds on the open [#4237](https://github.com/vercel/eve/pull/4237),
which replaces the closed [#4117](https://github.com/vercel/eve/pull/4117).
Coordinate implementation there; this draft proposes the SDK adoption boundary
and acceptance criteria, without adding another client implementation.

The sources checked on October 29, 2026 are:

- [AI SDK #24208](https://github.com/vercel/ai/pull/24208) is open.
  It adds form elicitation through `onElicitationRequest`, then retries
  with `inputResponses` and unchanged `requestState`. It does not support URL
  elicitation, sampling, or roots requests.
- The [MRTR specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)
  permits `input_required` only for `tools/call`, `prompts/get`, and
  `resources/read`. Connect's `events/subscribe` and webhook delivery are outside
  this flow.
- Current eve main, `8afb9048c`, creates AI SDK clients in
  [`mcp-client.ts`](../packages/eve/src/runtime/connections/mcp-client.ts) without
  an elicitation handler. Its current HITL implementation lives in
  [`harness/hitl`](../packages/eve/src/harness/hitl) and
  [`session-machine`](../packages/eve/src/harness/session-machine).
  The older request-table proposal linked from #4159 is historical context,
  not an implementation dependency to restore.

## Proposed authoring and user behavior

Start with an explicit connection opt-in. This API is proposed, not available:

```ts
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://deployments.example/mcp",
  description: "Inspect deployments and request rollbacks",
  experimental: { elicitation: { form: true } },
});
```

The connection keeps its existing auth, tool filters, provided arguments, and
approval policy. Local approval still gates a call before execution. A remote
question arrives during execution and does not count as approving other calls.
Authors do not receive raw SDK clients or write protocol callbacks.

Initially support tool calls and flat forms containing strings, booleans,
numbers, integers, and single-choice enums. Translate fields into eve's existing
questions and validate the complete form against its schema. Before submission,
show all typed answers and let the user reopen and edit any field, then confirm.
Identify the requesting connection and tool.
Reject unsupported schemas or constraints explicitly; never omit them silently.
This lets Slack and web chat reuse their question UI without requiring a general
JSON Schema form renderer in the first release.

| Input or outcome                        | Proposed behavior                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| Complete, valid form                    | Send `accept` with typed content.                                                   |
| User declines the remote request        | Send `decline`; do not create reusable approval memory.                             |
| User cancels only the form              | Send `cancel` if the call is still active.                                          |
| Turn is cancelled or steered            | Withdraw its questions and stop continuation; do not issue another network request. |
| Missing or different responder identity | Reject the answer and keep the request open.                                        |
| Anonymous or unattended session         | Fail with an actionable input-unavailable result; do not invent an answer.          |
| Unsupported request kind                | Fail explicitly without advertising that capability.                                |

Only the authenticated person whose call is held can answer. Resume with that
call's requester, not the latest speaker in a shared channel. Bind answers to
the session, turn, tool call, connection instance, round, and server request key.
Validate an entire input batch before showing any part of it. Submit the batch
only after all its answers are valid; never mix answers from concurrent calls.

## SDK and durability boundary

Let the AI SDK own protocol validation and wire behavior. Let eve own persisted
continuations, responder checks, channel rendering, and the held turn.

```mermaid
sequenceDiagram
  participant E as eve durable call
  participant S as MCP server
  participant U as Calling user
  E->>S: tools/call
  S-->>E: input_required + opaque state
  E->>E: Checkpoint continuation and questions
  E-->>U: Questions; turn.waiting on input
  U->>E: Authenticated answers
  E->>S: Same operation + answers + unchanged state
  S-->>E: Final result or another input round
```

**The SDK callback alone is not a durable continuation API.** In #24208 the
retry loop and `requestState` stay inside the client call; the elicitation
handler receives the form request. An in-memory promise waiting for a user
does not survive a worker restart. Re-running the original call on recovery
can also repeat work before the question.

Before enabling the feature, agree on an SDK surface that can return a bounded,
serializable pending round and resume it with answers on a new client. Keep it
behind an eve-owned adapter. This may require a follow-up to #24208; its current
callback API must not be described as sufficient. If that surface is unavailable,
keep the feature disabled. Do not revive #4117's fetch interception and payload
rewriting as a second protocol implementation.

Each network round should checkpoint its outcome before publishing questions.
Reuse the current HITL lifecycle to park and resume the same call and turn.
On recovery, rebuild the MCP client and continue the recorded round with fresh
JSON-RPC IDs, the original operation, the latest answers, and the exact opaque
state. Omit state when the latest round omitted it. Bind to the saved connection
instance and reauthorize access before sending. A changed endpoint, account, or
application-provided argument must stop continuation rather than retarget it.

Keep `requestState` and any sensitive continuation data in protected internal
durable storage. Do not put them in model messages, channel events, public
session projections, tool results, or telemetry. Store credential references,
not access tokens. Resolve credentials again for each round. Review the actual
checkpoint/projection path before choosing storage; generic session state is
not automatically private. Retire pending state when the call settles.

Proposed initial limits are three human input batches, three state-only retries,
16 requests per batch, 64 KiB of opaque state, and 8 KiB per displayed message.
Bound schemas, answers, and the total continuation size as well. Preserve a
persisted whole-call deadline across restarts, with a proposed ten-minute
default; align active network timeouts with the SDK without treating the human
wait as an open HTTP request. Show expiry clearly. An expired or rejected server
state fails the call; never silently restart the original operation.

MCP does not promise exactly-once side effects. A lost response after submission
can leave the outcome unknown. Resume from a committed round when possible;
do not blindly repeat an uncertain side-effecting call without a server-provided
idempotency guarantee. Withdrawal stops local continuation, but does not undo
work the remote server already accepted.

## Delivery slices

1. **Prove the SDK boundary.** Pin a release containing #24208 through eve's
   existing compiled dependency path. Add a restartable round API upstream if
   needed. Use a deterministic MCP fixture to prove checkpoint, process exit,
   and continuation before connecting any user UI.
2. **Adapt #4237's client work.** Use the current HITL machinery and the proposed
   opt-in. Preserve per-call ownership and local approval. Add the supported form
   mapping and clear unavailable, cancellation, and expiry outcomes. Update
   connection contracts, docs, and the changeset when implementation lands.
3. **Validate and expose the feature.** Exercise Slack and web chat, then an
   event-triggered session that already has an authorized interactive recipient.
   Keep unattended event callbacks noninteractive. The SDK dependency and eve
   adapter must ship before documenting the feature as available.

The first release does not add model-facing prompt/resource operations, URL
elicitation for remote sign-in, sampling, roots, server-side `mcpChannel`
changes, or multi-hop relay. Those remain separate parts of #4159 and
[#4146](https://github.com/vercel/eve/issues/4146). In particular, upgrading to
#24208 cannot complete #4237's remote sign-in support. Connect continues to own
credentials and Events subscriptions/delivery; it needs no new Events protocol
or dashboard behavior for this adoption.

## Acceptance criteria

| Coverage                  | Required result                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit and integration      | Form mapping, constraints, typed answers, decline/cancel, unsupported kinds, and work limits behave as specified. Users can review and edit every answer before submission.                                            |
| Concurrent calls          | Each round receives only its own answers/state, including when two calls share one MCP client.                                                                                                                         |
| Scenario                  | A server returns input-required, eve checkpoints and exits, and a new worker resumes the same call after an answer. Completed rounds do not restart.                                                                   |
| Authorization             | A second channel participant cannot answer; changed connection/account or access stops continuation; anonymous and unattended runs fail without prompting.                                                             |
| Cancellation and recovery | Steering, cancellation, expiry, duplicate answers, stale rounds, and ambiguous remote outcomes cannot trigger an unintended retry.                                                                                     |
| Privacy                   | Opaque state and application-only arguments never appear in model history, channel payloads, public projections, or traces.                                                                                            |
| E2E                       | A deterministic fixture completes an interactive form through the channel contract; a Connect event starts a session whose later tool call asks and resumes. Duplicate event delivery does not duplicate the question. |

Before implementation, settle the upstream resumable-round API and the protected
storage location with the owners of #24208 and #4237. Confirm the proposed schema
subset, limits, deadline, and opt-in during review. This PR changes only the plan.
