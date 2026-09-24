---
title: "Human-in-the-Loop"
description: "Pause a run for a person — gate a tool on approval or have the agent ask a question — and resume durably when they answer."
url: /human-in-the-loop
---

Human-in-the-loop (HITL) is any point where the agent durably pauses and waits for a person. Two things trigger it, and both ride the same pause-and-resume protocol:

- **Approvals** — a tool policy allows, denies, or pauses a call for a person to review. The agent decides to call the tool; the policy decides whether it runs automatically or needs a human decision.
- **Questions** — the agent itself asks the user a clarifying question or a choice mid-turn, and parks until they answer.

Either way the run parks at `session.waiting`, durably, for as long as it takes — seconds or days — and picks back up exactly where it left off once the answer arrives. Channels render the request for you.

## Approvals

Approval is a property of a [tool](/docs/tools) that gates it before it runs. The policy can decide automatically or pause for a person. Set `approval` with the helpers from `eve/tools/approval`:

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
| `auto()`   | Ask an evaluation model whether to run the exact call or require user approval.    |

By default, omitted `approval` behaves like `never()`, so tool calls may execute without human approval. Require human approval or other safeguards for sensitive, irreversible, regulated, financial, healthcare, employment, housing, legal, safety-impacting, user-impacting, or external side-effecting actions.

`auto()` uses an [AI SDK evaluation model](/docs/guides/evaluate) to classify each call as `clear` or `caution`. It defaults to `typesafe-ai/jev`, TypeSafe AI's [Jev evaluation model](https://vercel.com/i/what-is-jev). Like `evaluate`, a model string uses Vercel AI Gateway unless the application configures a global AI SDK default provider:

```ts
approval: auto({ model: "typesafe-ai/jev" });
```

The evaluation model reviews the tool name and input for dangerous effects. A caution, failed review, or incomplete input requires user approval. The tool input is sent to the evaluation model's provider.

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

You may also define an approval response policy that decides whether the authenticated person who selects **Approve** may approve that specific call:

```ts title="agent/tools/refund_charge.ts"
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Refund a charge.",
  inputSchema: z.object({ chargeId: z.string() }),
  approval: {
    request: always(),
    response: ({ responder, request, response, session, auth }) => {
      // The Slack channel authenticates the responder and includes the workspace and user IDs.
      // Larger apps can look up approver membership here instead.
      const approvers = ["slack:T012AB3CD:U045EF6GH", "slack:T012AB3CD:U078JK9LM"];
      const canApprove = approvers.includes(responder.principalId);

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

- `responder`: the authenticated principal that submitted the response, including its `principalId`, `principalType`, `authenticator`, and `attributes`. Your route or channel supplies this identity.
- `request`: the stable `requestId`, `callId`, `toolName`, and typed `toolInput` for the call being approved.
- `response`: the submitted decision. Response policies run for approval, so its current value is `{ decision: "approve" }`.
- `session`: read-only session identity and lineage: `id`, `initiator`, `parent`, and `turn`.
- `auth`: narrow `getToken(provider, options?)` and `requireAuth(provider, options?)` capabilities bound to the responder. Use these when authorization depends on a provider identity or permission; an interactive provider flow parks durably and then retries the policy.

Return `{ status: "allowed" }` to accept the approval. Return `{ status: "rejected", reason }` to leave the shared request pending so another eligible responder can approve it.

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

The user can always type their own answer instead of picking an option, so the model never needs an "Other" option. The tool returns `{ status: "answered", answer }` with the chosen option's label or the user's words, `{ status: "dismissed" }` when the user moved on without answering, or `{ status: "unavailable" }` when the session cannot request input.

`ask_question` is an [opt-in framework tool](/docs/concepts/built-in-tools#ask_question). Add it with `eve add tool/ask_question`, which creates this file:

```ts title="agent/tools/ask_question.ts"
import { askQuestion } from "eve/tools/ask_question";

export default askQuestion();
```

`ask_question` is an ordinary [workflow tool](/docs/tools/workflows) built on `ctx.ask()`. Write your own workflow tool with `ctx.ask()` when you need a different schema or want to act on the answer in the same call. Without any asking tool, the model asks in its reply text and the user's next message carries the answer.

## How pause and resume works

Approvals and questions share one protocol:

1. A tool call needs approval, or a workflow tool such as `ask_question` calls `ctx.ask()`.
2. eve emits an `input.requested` stream event carrying the pending requests.
3. The turn parks at `session.waiting`, durably, for as long as it takes.
4. The client answers with `inputResponses` (structured, keyed by `requestId`) or a normal follow-up `message`. A follow-up whose text matches an option ID, option label, or numeric option index resolves automatically, including approval options such as `approve` and `cancel`.

For `ctx.ask()` questions from workflow tools and questions from subagents, a follow-up message answers the question only when exactly one question is pending. The message must match an option, or the question must allow free text. Otherwise the message reaches the model as a normal turn, and each pending question this session's workflow tools created with `dismissible: true` resolves as `dismissed`.

In an interactive root session, a follow-up message that answers nothing also moves the calls still waiting to the background, such as a workflow tool whose question is not dismissible or a subagent waiting on an approval. Their requests stay pending and answerable, and each call's result arrives in a later message once it finishes. See [Detach a waited call](/docs/concepts/tasks#detach-a-waited-call).

Each request includes a `kind` discriminator: `tool-approval`, `question`, or
`session-limit`. Clients should use `kind` to choose behavior and presentation.
`requestId` identifies the request to answer, and `action.callId` identifies the
tool call that raised it; neither encodes the request's semantics.

The run picks back up exactly where it parked. Because the pause is durable, nothing is held in memory while it waits — the process can restart and the parked turn survives.

When a subagent requests input, eve emits the same `input.requested` event on its parent session, with the `taskId` of the call that asked. Answering through that parent session routes the response directly to the blocked child without invoking the parent model. The child resolves the request, and its `input.resolved` then appears on the parent session too. This works the same for a local subagent and a [remote agent](/docs/guides/remote-agents#questions-approvals-and-sign-in): a remote child's request reaches the parent over the parent's callback URL, and eve forwards your answer to the remote deployment. A child inherits the parent session's capabilities, so it can ask only when the parent session can request input. Anyone who can send to the parent session can answer; the child attributes the answer to that principal, the `responder` your response policy checks, and keeps acting as the principal that started it.

For approval requests, unrelated follow-up text does not deny the tool call. eve keeps the approval pending and records that pending state in model-visible session history. Follow-up turns run normally and may call other tools while the approval remains unresolved. Once it is answered, eve settles the original tool call exactly once.

See [Sessions, runs & streaming](/docs/concepts/sessions-runs-and-streaming) for the full event and resume contract that this builds on.

## Answering from a client or channel

Channels turn requests into native UI: the Slack adapter renders approvals as buttons and questions as select menus, and writes the user's choice back as the answer. You get this for free on every [channel](/docs/channels/overview).

From your own frontend, scan all messages for pending requests and answer through the same session — see [Building a frontend](/docs/guides/frontend/overview#human-in-the-loop-prompts) for the client-side reducer and `inputResponses` shape.

## What to read next

- [Tools](/docs/tools): define the typed actions an approval gates
- [Built-in tools](/docs/concepts/built-in-tools): the default tools and opt-in tools such as `ask_question`
- [Sessions, runs & streaming](/docs/concepts/sessions-runs-and-streaming): the event and resume contract behind the pause
- [Building a frontend](/docs/guides/frontend/overview): render and answer requests from your own UI
- [Multi-tenant approvals](/docs/patterns/multi-tenant-approvals): resolve per-tenant approval policy for authored and connection tools
