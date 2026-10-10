---
title: "Human-in-the-Loop"
description: "Pause a run for a person — gate a tool on approval or have the agent ask a question — and resume durably when they answer."
url: /human-in-the-loop
---

Human-in-the-loop (HITL) is any point where the agent durably pauses and waits for a person. Two things trigger it, and both ride the same pause-and-resume protocol:

- **Approvals** — a tool policy allows, denies, or pauses a call for a person to review. The agent decides to call the tool; the policy decides whether it runs automatically or needs a human decision.
- **Questions** — the agent itself asks the user a clarifying question or a choice mid-turn, and parks until they answer.

Both keep the turn open, and the stream reports `turn.paused` awaiting the person. The run waits durably, for as long as it takes — seconds or days — and picks back up exactly where it left off once the answer arrives. Channels render the request for you.

## Approvals

Approval is a property of a [tool](/docs/tools) that gates it before it runs. This includes [workflow tools](/docs/tools/workflows): a call waiting for approval does not start its workflow, and a call denied by a policy or person never runs. Other calls from the same model response that do not require approval can proceed while it waits.

The policy can decide automatically or pause for a person. Set `approval` with the helpers from `eve/tools/approval`:

```ts title="agent/tools/refund_charge.ts"
import { defineTool } from "eve/tools";
import { auto } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Refund a charge.",
  inputSchema: z.object({ tenantId: z.string(), chargeId: z.string(), amount: z.number() }),
  approval: auto(), // or always() / once() / never() / a policy
  async execute(input) {
    return refund(input);
  },
});
```

| Helper     | Behavior                                                                           |
| ---------- | ---------------------------------------------------------------------------------- |
| `never()`  | Never require approval (the default when omitted).                                 |
| `once()`   | Require approval only the first time the tool runs in a session; auto-allow after. |
| `always()` | Require approval before every call.                                                |
| `auto()`   | Ask a decision model whether to run the exact call or require user approval.       |

By default, omitted `approval` behaves like `never()`, so tool calls may execute without human approval. Require human approval or other safeguards for sensitive, irreversible, regulated, financial, healthcare, employment, housing, legal, safety-impacting, user-impacting, or external side-effecting actions.

`auto()` uses an [AI SDK decision model](/docs/guides/decide) to classify each call as `clear` or `caution`. It defaults to `typesafe-ai/jev`, TypeSafe AI's [Jev decision model](https://vercel.com/i/what-is-jev). Like `decide`, a model string uses Vercel AI Gateway unless the application configures a global AI SDK default provider:

```ts
approval: auto({ model: "typesafe-ai/jev" });
```

The decision model reviews the tool name and input for dangerous effects. A caution, failed review, or incomplete input requires user approval. The tool input is sent to the decision model's provider.

Override the classifier text for application-specific policy:

```ts
approval: auto({
  model: "typesafe-ai/jev",
  instructions: "Review whether this refund needs finance approval.",
  criteria: {
    clear: "The refund can proceed automatically.",
    caution: "A person must review the refund.",
  },
});
```

A reusable approval grant applies only after every matching request that is already pending has been resolved. If several calls to a `once()`-gated tool have each produced an approval prompt, approving one does not authorize the others; each visible prompt remains an independent decision. After those pending requests are resolved, later calls in the session are allowed automatically.

When the decision depends on the input, pass your own policy instead of a helper. It receives the same session context as tool execution, plus `{ toolName, toolInput, approvedTools, callId, abortSignal }`, and returns an AI SDK 7 approval status synchronously or as a promise. Use `abortSignal` for asynchronous policy work so cancellation stops it with the turn. Use `ctx.session.auth.current` to guard by the caller of the current turn and `ctx.session.auth.initiator` to guard by the caller that created the session. Return `"user-approval"` to pause for a person or `"not-applicable"` to continue without a prompt. `toolInput` can be undefined, so guard the access. This policy denies cross-tenant calls, then requires approval only when an amount crosses a threshold:

```ts
approval: ({ session, toolInput }) => {
  const callerTenant = session.auth.current?.attributes.tenantId;
  if (callerTenant === undefined || callerTenant !== toolInput?.tenantId) {
    return { type: "denied", reason: "Caller cannot access this tenant." };
  }
  return (toolInput?.amount ?? 0) > 1000 ? "user-approval" : "not-applicable";
},
```

For compatibility with the previous predicate shape, policies may return booleans: `true` is treated as `"user-approval"` and `false` as `"not-applicable"`. Boolean promises are supported too.

Policies can also return `"approved"` or `"denied"` to decide automatically. Use `{ type: "approved" | "denied", reason }` when the model should receive a reason. The `Approval`, `ApprovalContext`, and `ApprovalStatus` types are exported from `eve/tools/approval`.

Gating a side effect on approval is also how you make non-idempotent work safe across replays: a charge or email that sits behind `always()` can't fire from a re-run step without a fresh human decision.

### Authorizing approval responses

By default, only the person whose turn requested a call can approve or cancel it.

Define an approval response policy to change who may settle a call, for example, to specify a set of designated approvers who must approve a certain tool. A tool with a `response` policy replaces the default entirely, so return `{ status: "allowed" }` to let any responder through:

```ts title="agent/tools/refund_charge.ts"
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Refund a charge.",
  inputSchema: z.object({ chargeId: z.string() }),
  approval: {
    request: always(),
    response: ({ request, response, session, auth }) => {
      // The Slack channel authenticates the responder and includes the workspace and user IDs.
      // Larger apps can look up approver membership here instead.
      const approvers = ["slack:T012AB3CD:U045EF6GH", "slack:T012AB3CD:U078JK9LM"];
      const canApprove = approvers.includes(response.principal.principalId);

      return canApprove
        ? { status: "allowed" }
        : { status: "rejected", reason: "This user cannot approve refunds." };
    },
  },
  async execute(input) {
    return refund(input);
  },
});
```

The `response` policy receives:

- `request`: the stable `requestId`, `callId`, `toolName`, and typed `toolInput` for the call being approved, plus `principal`: the authenticated principal whose turn requested the call, or `null` when that caller was unauthenticated or anonymous. eve captures `request.principal` when the approval is requested, so it stays the same while other people continue the session.
- `response`: the submitted `decision`, `"approve"` or `"cancel"`, plus `principal`: the authenticated principal that submitted it, including its `principalId`, `principalType`, `authenticator`, and `attributes`. Your route or channel supplies this identity. The policy runs for both decisions, so a responder it rejects can neither approve nor cancel the call.
- `session`: read-only session identity and lineage: `id`, `initiator`, `parent`, and `turn`.
- `auth`: narrow `getToken(provider, options?)` and `requireAuth(provider, options?)` capabilities bound to the responder. Use these when authorization depends on a provider identity or permission; an interactive provider flow parks durably and then retries the policy.

Return `{ status: "allowed" }` to accept the decision. Return `{ status: "rejected", reason }` to leave the shared request pending so another eligible responder can settle it. When a policy only cares who approves, return `{ status: "allowed" }` for `cancel` so anyone can still dismiss the request.

`session.initiator` is the person who started the session, and `request.principal` is the person who asked for this call. In a shared thread they can differ. Compare the full identity of `response.principal` with `request.principal` to let only the requester settle the call:

```ts title="agent/tools/publish_release.ts"
import { defineTool } from "eve/tools";
import type { SessionAuthContext } from "eve/context";
import { always } from "eve/tools/approval";
import { z } from "zod";

function samePrincipal(a: SessionAuthContext, b: SessionAuthContext): boolean {
  return (
    a.authenticator === b.authenticator &&
    a.issuer === b.issuer &&
    a.principalType === b.principalType &&
    a.principalId === b.principalId
  );
}

export default defineTool({
  description: "Publish a release.",
  inputSchema: z.object({ version: z.string() }),
  approval: {
    request: always(),
    // `request.principal` is null for an unauthenticated or anonymous caller, so no one matches it.
    response: ({ request, response }) =>
      request.principal !== null && samePrincipal(response.principal, request.principal)
        ? { status: "allowed" }
        : { status: "rejected", reason: "Only the person who asked for this release can respond." },
  },
  async execute(input) {
    return publish(input);
  },
});
```

When the policy refuses a response, the approval stays open and the turn stays paused. The stream records the answer as `response.submitted`, then `response.settled` with `outcome: "refused"` and the policy's `reason`, and the turn pauses on the approval again with `turn.paused`. The answer's delivery settles too, so a client reading that response stops, and the approval prompt stays answerable. Submitting an answer does not confirm approval: `interaction.settled` records the server's decision.

Every answer a policy evaluates is recorded before the policy runs, so slow policy work cannot lose it. An allowed answer is `response.admitted`; it applies, settling `applied`, when its interaction is decided, and the call then starts with `clearedBy` naming the interaction. An approval without a `response` policy admits answers as they arrive. An answer can also settle `failed` or `expired`; its `reason` says why.

### Skipping approval for schedule-dispatched turns

`session.auth.current` identifies the caller of this turn. Markdown schedules use the app principal (`authenticator: "app"`, `principalId: "eve:app"`, `principalType: "runtime"`) automatically. A `run` schedule must pass its `appAuth` to `send(...)` for the child session to use that principal. Match all three fields to skip approval for automated turns while still prompting when a person calls the same tool:

```ts title="agent/tools/refund_charge.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Refund a charge.",
  inputSchema: z.object({ chargeId: z.string(), amount: z.number() }),
  approval: ({ session }) => {
    const auth = session.auth.current;
    return auth?.authenticator === "app" &&
      auth.principalId === "eve:app" &&
      auth.principalType === "runtime"
      ? "not-applicable"
      : "user-approval";
  },
  async execute(input) {
    return refund(input);
  },
});
```

`session` in `approval` has the same shape as `ctx.session` in `execute`: `id`, `auth`, `turn`, and an optional `parent`. If a person later resumes a schedule-started session, `session.auth.current` becomes that person while `session.auth.initiator` remains the app principal. Inspect `initiator` only when the policy should apply to the whole session. Skipping approval on scheduled turns means any non-idempotent side effect will re-fire if a step replays, so pair this pattern with idempotency keys or `once()` where needed.

## Questions

The `ask_question` tool lets the model pause and ask the user one question, rather than guessing. The model calls it with `{ question, options? }`:

- `question`: the question to put to the user, with the context needed to answer it.
- `options`: two or three mutually exclusive choices, each with a `label` and a one-sentence `description`. Channels render these as buttons or a select menu. Omit `options` for an open-ended question.

The user can always type their own answer instead of picking an option, so the model never needs an "Other" option. The tool returns `{ status: "answered", answer }` with the chosen option's label or the user's words, `{ interrupted: true }` when a new message arrived that did not answer the question, or `{ status: "unavailable" }` when the session cannot request input.

`ask_question` is an [opt-in framework tool](/docs/concepts/built-in-tools#ask_question). Add it with `eve add tool/ask_question`, which creates this file:

```ts title="agent/tools/ask_question.ts"
import { askQuestion } from "eve/tools/ask_question";

export default askQuestion();
```

`ask_question` is an ordinary [workflow tool](/docs/tools/workflows) built on `ctx.ask()`. Write your own workflow tool with `ctx.ask()` when you need a different schema or want to act on the answer in the same call. Without any asking tool, the model asks in its reply text and the user's next message carries the answer.

In a custom workflow tool, an answered `ctx.ask()` returns the authenticated responder's `authenticator`, `principalId`, and `principalType` when that identity is available. It does not include channel attributes. `ctx.session.auth.current` remains the run's auth snapshot; use the response's `responder` to identify who answered.

## How pause and resume works

Approvals and questions share one protocol:

1. A tool call needs approval, or a workflow tool such as `ask_question` calls `ctx.ask()`.
2. eve emits an `interaction.opened` fact for each pending request.
3. The run parks durably, for as long as it takes. The turn stays open: the stream emits `turn.paused` awaiting those interactions, and after the answer `turn.resumed`, under the same `turnId`.
4. The client answers with `inputResponses` (structured, keyed by `requestId`) or a normal follow-up `message`. A follow-up whose text matches an option ID, option label, or numeric option index resolves automatically, including approval options such as `approve` and `cancel`.

To tell the model why a call was denied, send `text` with the `cancel` response, for example `{ requestId, optionId: "cancel", text: "Only the three-pack." }`. The model receives the note quoted in the denial result, marked as written by the person who denied the call, who may not be the user. The note is also visible to anyone who can read the session stream, in the `response.submitted` and `interaction.settled` facts.

For `ctx.ask()` questions from tools and prompts proxied from subagents, a follow-up message answers the first open request, as described in [Several requests at once](#several-requests-at-once). The message must match an option, or the question must allow free text. Otherwise the message follows the session's `turnPolicy`. A steering message, the default, aborts the `ctx.abortSignal` of each `execute` workflow tool call the turn waits on, so a question such a call asked, such as `ask_question`'s, is withdrawn: its interaction settles `withdrawn`. The model reads the message once those calls settle.

On the stream, each interaction's `request.kind` is `approval`, `question`, `budget`, or `sign-in`,
and its `subject` names the call or turn it is about. The client's `InputRequest` keeps its
`kind` discriminator: `tool-approval`, `question`, or `session-limit`. Clients should use `kind`
to choose behavior and presentation. `requestId` (the stream's `interactionId`) identifies the
request to answer, and `action.callId` identifies the tool call that raised it; neither encodes
the request's semantics.

The run picks back up exactly where it parked. Because the pause is durable, nothing is held in memory while it waits — the process can restart and the parked turn survives.

When a subagent requests input, its parent session relays it as its own `interaction.opened`, with `origin` naming the child session and request, and `origin.call` naming the child's call. Answering through that parent session routes the response directly to the blocked child without invoking the parent model.

Approval is consent only. An approved tool call runs with the requesting user's identity, connections, and credentials, including its policy recheck. The approver's access is never lent to the call. Subsequent tool calls in the turn also stay with the original owner.

For approval requests, a follow-up message that doesn't match an option steers the turn instead of answering it. eve withdraws the turn's pending approval: its interaction settles `withdrawn`, its call settles `rejected` without running, and the model reads the message next. This happens even when the message is sent with `turnPolicy: "queue"`, because a turn held on a person can't end until they act. Calls the person already approved in the same batch still run. A message from someone other than the person the turn serves waits until the turn ends. Cancelling the turn interrupts its approval: the call doesn't run, the interaction settles `interrupted`, and a later answer to it approves nothing.

### Several requests at once

A turn can wait on more than one request, such as two `ctx.ask()` questions a workflow tool asks with `Promise.all`, or approvals for two tool calls the model made in one step. A follow-up message answers only the first open request: a [runtime limit](/docs/agent-config#runtime-limits) continuation prompt if one is open, and otherwise the request eve asked for first, in the order of its `interaction.opened` facts.

The message answers that request when it matches one of its options, or when the request accepts free text. Otherwise the message is not an answer and follows the rules above. To answer several requests by text, send one message per request.

An approval for a tool call made in the same step as a workflow tool call, such as `ask_question`, is not requested until the workflow tool call finishes, because the approved call can't run before then. The person answers the question first, then sees the approval.

Channels that show only text show one request at a time, in this order, and post the next once the current one is answered, so a reply answers the request the person sees. Twilio, GitHub, Linear, and Chat SDK channels work this way. Chat SDK can't tell whether an adapter shows buttons, so every Chat SDK channel shows requests one at a time, including Linq, Photon, and adapters with buttons. Native channels with buttons, such as Slack, show every open request so a person can press any of them, and a typed reply still answers the first.

See [Sessions, runs & streaming](/docs/concepts/sessions-runs-and-streaming) for the full event and resume contract that this builds on.

## Answering from a client or channel

Channels turn requests into native UI: the Slack adapter renders approvals as buttons and questions as select menus, and writes the user's choice back as the answer. You get this for free on every [channel](/docs/channels/overview).

From your own frontend, scan all messages for pending requests and answer through the same session — see [Building a frontend](/docs/guides/frontend/overview#human-in-the-loop-prompts) for the client-side reducer and `inputResponses` shape.

You can answer while a turn is running, such as the second approval of a batch while the first answer is still settling. The default message reducer waits for server confirmation before marking any input request answered. A submitted answer marks its request `responded` in `data.inputs` until its `interaction.settled` arrives, and a refused answer reopens it; submitting a response alone does not resolve an approval, question, or session-limit prompt. Answering a request that is no longer open rejects without a server request. The `client.input.responded` event remains a submission notification for custom reducers, not confirmation that the server accepted the answer.

## What to read next

- [Tools](/docs/tools): define the typed actions an approval gates
- [Built-in tools](/docs/concepts/built-in-tools): the default tools and opt-in tools such as `ask_question`
- [Sessions, runs & streaming](/docs/concepts/sessions-runs-and-streaming): the event and resume contract behind the pause
- [Building a frontend](/docs/guides/frontend/overview): render and answer requests from your own UI
- [Multi-tenant approvals](/docs/patterns/multi-tenant-approvals): resolve per-tenant approval policy for authored and connection tools
