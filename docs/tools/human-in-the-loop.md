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

| Helper     | Behavior                                                                     |
| ---------- | ---------------------------------------------------------------------------- |
| `never()`  | Never require approval (the default when omitted).                           |
| `once()`   | Remember approval for this tool for the rest of the session.                 |
| `always()` | Require approval before every call.                                          |
| `auto()`   | Ask a decision model whether to run the exact call or require user approval. |

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

Dynamic tools rebuild their policies when evaluated. Use [`ctx.memo()`](/docs/guides/dynamic-capabilities) to keep external JSON observations used to configure a policy.

Each pending approval needs its own answer. A `once()` approval applies to later calls, not other already-open prompts.

Use the object form of `approval` to replace the default `Approve <tool label>?` text with a tool-specific summary. The `prompt` callback receives the validated `input`, final `toolName`, and `callId`:

```ts title="agent/tools/refund_charge.ts"
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Refund a charge.",
  inputSchema: z.object({ chargeId: z.string(), amount: z.number() }),
  approval: {
    request: always(),
    prompt: ({ input }) => `Refund $${input.amount.toFixed(2)} for charge ${input.chargeId}?`,
  },
  async execute(input) {
    return refund(input);
  },
});
```

Channels render this prompt in their approval UI. Slack also includes the complete tool input in a collapsed **Tool input** block so an approver can inspect the original structured value.

When the decision depends on the input, pass your own policy instead of a helper. It receives the same session context as tool execution, plus `{ toolName, toolInput, callId, abortSignal }` (connection tools also get `toolAnnotations`), and returns an AI SDK 7 approval status synchronously or as a promise. Use `abortSignal` for asynchronous policy work so cancellation stops it with the turn. Use `ctx.session.auth.current` to guard by the caller of the current turn and `ctx.session.auth.initiator` to guard by the caller that created the session. Return `"user-approval"` to pause for a person or `"not-applicable"` to continue without a prompt. `toolInput` can be undefined, so guard the access. This policy denies cross-tenant calls, then requires approval only when an amount crosses a threshold:

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

Policies can also return `"approved"` or `"denied"` to decide automatically. Use `{ type: "denied", reason }` when the model should receive a reason for denying the call. A denied call never starts: it settles `call.settled` with `outcome: "rejected"`, `cause: { policy: "approval" }`, and a `TOOL_EXECUTION_DENIED` output, whether the policy denies it as the model calls it or when an approved call is checked again. A tool that runs and throws settles `failed`. An explicit `"approved"` result records `clearedBy: { policy: "approval" }` on `call.started`. A call cleared by a remembered `once()` approval records the same `{ policy: "approval" }`; a call approved by a person records `{ interactionId }`. Calls that need no approval omit `clearedBy`. The `Approval`, `ApprovalConfiguration`, `ApprovalContext`, `ApprovalPolicy`, and `ApprovalStatus` types are exported from `eve/tools/approval`.

Approval is not an exactly-once guarantee for a charge or email. Give non-idempotent side effects their own idempotency keys.

### Remember approval for a tool

`once()` remembers the latest decision people gave its prompts for the resolved tool name, across turns and context clears, until the session ends. A remembered approval covers later calls to that tool regardless of their input; it does not clear a different tool. A later denial of a `once()` prompt for the tool replaces it, so the next call asks again. When one delivery answers several of those prompts, a denial among its answers stands. Approving a prompt asked by `always()` or by a policy that does not return `once()`'s decision remembers nothing, and so does a wrapping policy that calls `once()` but returns a different status. Existing pending prompts still need their own answers.

A remembered approval is consent, not authorization. Authorize the current caller on every call. Use `always()` or an input-dependent policy when different tenants, environments, or other inputs need separate approval decisions. When wrapping `once()` in another policy, forward the policy context and return its status object unchanged.

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

- `request`: the stable `interactionId`, `callId`, `toolName`, and typed `toolInput` for the call being approved, plus `principal`: the authenticated principal whose turn requested the call, or `null` when that caller was unauthenticated or anonymous. eve captures `request.principal` when the approval is requested, so it stays the same while other people continue the session.
- `response`: the submitted `decision`, `"approve"` or `"deny"`, plus `principal`: the authenticated principal that submitted it, including its `principalId`, `principalType`, `authenticator`, and `attributes`. Your route or channel supplies this identity. The policy runs for both decisions, so a responder it rejects can neither approve nor deny the call.
- `session`: read-only session identity and lineage: `id`, `initiator`, `parent`, and `turn`.
- `auth`: narrow `getToken(provider, options?)` and `requireAuth(provider, options?)` capabilities bound to the responder. Use these when authorization depends on a provider identity or permission; an interactive provider flow parks durably and then retries the policy.

Return `{ status: "allowed" }` to accept the decision. Return `{ status: "rejected", reason }` to leave the shared request pending so another eligible responder can settle it. When a policy only cares who approves, return `{ status: "allowed" }` for `deny` so anyone can still dismiss the request.

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

When the policy refuses a response, its `response.settled` reports `outcome: "refused"` and the approval stays open for another answer. Submitting an answer does not approve the call on its own: wait for `interaction.settled` to confirm the decision.

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

export default askQuestion;
```

`ask_question` is an ordinary [workflow tool](/docs/tools/workflows) built on `ctx.ask()`. Write your own workflow tool with `ctx.ask()` when you need a different schema or want to act on the answer in the same call. Without any asking tool, the model asks in its reply text and the user's next message carries the answer.

In a custom workflow tool, an answered `ctx.ask()` returns the authenticated responder's `id`, `type`, and optional `issuer` when that identity is available. It does not include channel attributes. `ctx.session.auth.current` remains the run's auth snapshot; use the response's `responder` to identify who answered.

## How pause and resume works

Approvals and questions share one protocol:

1. A tool call needs approval, or a workflow tool such as `ask_question` calls `ctx.ask()`.
2. eve emits an `interaction.opened` fact for each pending request.
3. The run parks durably, for as long as it takes. The turn stays open: the stream emits `turn.paused` awaiting those interactions, and after the answer the turn runs on under the same `turnId`.
4. The client answers with `answers` (structured, each naming its `interactionId`) or a normal follow-up `message`. A follow-up whose text matches an option ID, option label, or numeric option index resolves automatically, including approval options such as `approve` and `deny`.

To tell the model why a call was denied, send `text` with the `deny` response, for example `{ interactionId, optionId: "deny", text: "Only the three-pack." }`. The model receives the note quoted in the denial result, marked as written by the person who denied the call, who may not be the user. The note is also visible to anyone who can read the session stream, in the `response.submitted` and `interaction.settled` facts.

For `ctx.ask()` questions from tools and prompts proxied from subagents, a follow-up message answers the first open request, as described in [Several requests at once](#several-requests-at-once). The message must match an option, or the question must allow free text. Otherwise the message follows the session's `turnPolicy`. A steering message, the default, aborts the `ctx.abortSignal` of each `execute` workflow tool call the turn waits on, so a question such a call asked, such as `ask_question`'s, is withdrawn: its interaction settles `withdrawn`. The model reads the message once those calls settle.

On the stream, each interaction's `request.kind` is `approval`, `question`, `budget`, or `sign-in`,
and its `subject` names the call, task, or turn it is about. Clients read the same interaction as an
`Interaction`, with the same nested `request.kind`; use it to choose behavior and presentation, and keep a
default branch, since a later release can add a kind. `interactionId` identifies the interaction to
answer, and `call.callId`, when present, identifies the call it is about; neither encodes the
interaction's semantics.

The run picks back up exactly where it parked. Because the pause is durable, nothing is held in memory while it waits — the process can restart and the parked turn survives.

When a subagent requests input, its parent session relays it as its own `interaction.opened`, with `origin` naming the child session and request, and `origin.call` naming the child's call. Answering through that parent session routes the response directly to the blocked child without invoking the parent model.

A message from the parent agent to a subagent never answers the subagent's tool approval or session-limit request, even when its text matches an option such as `approve` or `continue`. Only a person's structured answer, routed through the parent session, settles these requests. The subagent still receives the parent's message as an ordinary message. It steers the turn past a pending approval, whose interaction settles `withdrawn`, and waits behind a session-limit request until a person answers it.

Approval is consent only. An approved tool call runs with the requesting user's identity, connections, and credentials, including its policy recheck. The approver's access is never lent to the call. Subsequent tool calls in the turn also stay with the original owner.

A `defineTool` tool can still act on the approver's behalf when it chooses to. While an approved `defineTool` call runs, `ctx.approval.responder` is the principal who approved it, and `ctx.approval.responder.getToken(provider)` resolves that person's token for an inline provider, as `ctx.getToken(provider)` does for the requester. `ctx.session.auth.current` stays the requester. `ctx.approval` is absent for calls that needed no approval, and workflow tools don't receive it. `ctx.approval.responder.getToken(provider)` never starts a sign-in: when the approver has no token, it throws a `ConnectionAuthorizationFailedError` with `reason: "approver_authorization_required"`.

```ts
export default defineTool({
  description: "Grant the requester access to a repository.",
  inputSchema: z.object({ repo: z.string() }),
  approval: {
    request: always(),
    response: ({ response }) =>
      itAdmins.includes(response.principal.principalId)
        ? { status: "allowed" }
        : { status: "rejected" },
  },
  async execute({ repo }, ctx) {
    const admin = await ctx.approval?.responder.getToken(github);
    if (admin === undefined) throw new Error("An IT admin must approve this grant.");
    return await grantAccess(repo, ctx.session.auth.current, admin.token);
  },
});
```

For approval requests, a follow-up message that doesn't match an option steers the turn instead of answering it. eve withdraws every approval nobody has answered: each interaction settles `withdrawn`, its call settles `rejected` without running, and the model reads the message next. This happens even when the message is sent with `turnPolicy: "queue"`, because a turn held on a person can't end until they act. Approvals that already have an answer settle on it, so calls the person already approved still run. A message from someone other than the person the turn serves waits until the turn ends. Cancelling the turn interrupts its approval: the call doesn't run, the interaction settles `interrupted`, and a later answer to it approves nothing.

### Several requests at once

A turn can wait on more than one request, such as two `ctx.ask()` questions a workflow tool asks with `Promise.all`, or approvals for two tool calls the model made in one step. A follow-up message answers only the first open request: a [runtime limit](/docs/agent-config#runtime-limits) continuation prompt if one is open, and otherwise the request eve asked for first, in the order of its `interaction.opened` facts.

The message answers that request when it matches one of its options, or when the request accepts free text. Otherwise the message is not an answer and follows the rules above. To answer several requests by text, send one message per request.

An approval for a tool call made in the same step as a workflow tool call, such as `ask_question`, is not requested until the workflow tool call finishes, because the approved call can't run before then. The person answers the question first, then sees the approval.

Channels that show only text show one request at a time, in this order, and post the next once the current one is answered, so a reply answers the request the person sees. Twilio, GitHub, Linear, and Chat SDK channels work this way. Chat SDK can't tell whether an adapter shows buttons, so every Chat SDK channel shows requests one at a time, including Linq, Photon, and adapters with buttons. Native channels with buttons, such as Slack, show every open request so a person can press any of them, and a typed reply still answers the first. A Slack app that sets `onInputResponse` or `approvalChannel` takes answers only through its controls; see [Restrict who can invoke the agent](/docs/channels/slack#restrict-who-can-invoke-the-agent).

See [Sessions, runs & streaming](/docs/concepts/sessions-runs-and-streaming) for the full event and resume contract that this builds on.

## Answering from a client or channel

Channels turn requests into native UI: the Slack adapter renders approvals as buttons and questions as select menus, and writes the user's choice back as the answer. You get this for free on every [channel](/docs/channels/overview).

In your own frontend, use `openInteractions(view)` and `respond([{ interactionId, optionId }])` on the same session. See [Building a frontend](/docs/guides/frontend/overview#human-in-the-loop-prompts).

You can answer while other work runs. An interaction stays `open` until `interaction.settled`; the frontend example shows how to query pending prompts.

## What to read next

- [Tools](/docs/tools): define the typed actions an approval gates
- [Built-in tools](/docs/concepts/built-in-tools): the default tools and opt-in tools such as `ask_question`
- [Sessions, runs & streaming](/docs/concepts/sessions-runs-and-streaming): the event and resume contract behind the pause
- [Building a frontend](/docs/guides/frontend/overview): render and answer requests from your own UI
- [Multi-tenant approvals](/docs/patterns/multi-tenant-approvals): resolve per-tenant approval policy for authored and connection tools
