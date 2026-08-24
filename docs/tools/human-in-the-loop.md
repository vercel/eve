---
title: "Human-in-the-Loop"
description: "Pause a run for a person — gate a tool on approval or have the agent ask a question — and resume durably when they answer."
url: /human-in-the-loop
---

Human-in-the-loop (HITL) is any point where the agent durably pauses and waits for a person. Two things trigger it, and both ride the same pause-and-resume protocol:

- **Approvals** — a tool requires a person to sign off before (or instead of) running. The agent decides to call the tool; a human decides whether it does.
- **Questions** — the agent itself asks the user a clarifying question or a choice mid-turn, and parks until they answer.

Either way the run parks at `session.waiting`, durably, for as long as it takes — seconds or days — and picks back up exactly where it left off once the answer arrives. Channels render the request for you.

## Approvals

Approval is a property of a [tool](/docs/tools) that pauses for a person before it runs. Gate a tool with `approval` and the helpers from `eve/tools/approval`:

```ts title="agent/tools/refund_charge.ts"
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Refund a charge.",
  inputSchema: z.object({ tenantId: z.string(), chargeId: z.string(), amount: z.number() }),
  approval: always(), // or once() / never() / a policy
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

By default, omitted `approval` behaves like `never()`, so tool calls may execute without human approval. Require human approval or other safeguards for sensitive, irreversible, regulated, financial, healthcare, employment, housing, legal, safety-impacting, user-impacting, or external side-effecting actions.

When the decision depends on the input, pass your own policy instead of a helper. It receives the same session context as tool execution, plus `{ toolName, toolInput, approvedTools, callId }`, and returns an AI SDK 7 approval status synchronously or as a promise. Use `ctx.session.auth.current` to guard by the caller of the current turn and `ctx.session.auth.initiator` to guard by the caller that created the session. Return `"user-approval"` to pause for a person or `"not-applicable"` to continue without a prompt. `toolInput` can be undefined, so guard the access. This policy denies cross-tenant calls, then requires approval only when an amount crosses a threshold:

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

Policies can also return `"approved"` or `"denied"` to decide automatically. Use `{ type: "approved" | "denied", reason }` when the model should receive a reason. The `Approval`, `ApprovalContext`, and `ApprovalStatus` types are exported from both `eve/tools` and `eve/tools/approval`.

Gating a side effect on approval is also how you make non-idempotent work safe across replays: a charge or email that sits behind `always()` can't fire from a re-run step without a fresh human decision.

### Authorizing approval responses

A request-time policy decides whether a tool call needs approval. A response-time policy decides whether the authenticated person who selects **Approve** may approve that specific call. Use the object form of `approval` when approval must come from a particular user, role, or tenant. The same object form works for authored tools and connection-wide approval:

```ts title="agent/tools/refund_charge.ts"
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Refund a charge.",
  inputSchema: z.object({ chargeId: z.string() }),
  approval: {
    request: always(),
    response: ({ responder }) => {
      // Your route or channel authenticates the responder and supplies this ID.
      // This example allows one configured user; larger apps can look up membership here.
      const canApprove = responder.principalId === process.env.REFUND_APPROVER_ID;

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

- `responder`: the authenticated principal that submitted the response, including its `principalId`, `principalType`, `authenticator`, and `attributes`. Your route or channel supplies this identity. Attribute names and values are defined by your application, not by eve.
- `request`: the stable `requestId`, `callId`, `toolName`, and typed `toolInput` for the call being approved.
- `response`: the submitted decision. Response policies run for approval, so its current value is `{ decision: "approve" }`.
- `session`: read-only session identity and lineage: `id`, `initiator`, `parent`, and `turn`.
- `auth`: narrow `getToken(provider, options?)` and `requireAuth(provider, options?)` capabilities bound to the responder. Use these when authorization depends on a provider identity or permission; an interactive provider flow parks durably and then retries the policy.

Return `{ status: "allowed" }` to accept the approval. Return `{ status: "rejected", reason }` to leave the shared request pending so another eligible responder can approve it. Errors, timeouts, and invalid results fail closed and also leave the request pending. eve emits the reason on the `approval.candidate` event so channels can show it to the responder, but it does not become a tool result because the tool call has not been settled.

A response policy does not run when someone selects **Cancel**; cancellation prevents the tool from running. eve still requires an authenticated responder when the approval has a response policy. Your route or channel must authenticate the responder and prevent unauthorized tenants from accessing the session in the first place.

Response authorization is a gate, not a substitute for authorization inside `execute`. Recheck access before the side effect because identity, membership, or policy can change while the run is parked. See [Multi-tenant approvals](/docs/patterns/multi-tenant-approvals#protect-the-approval-response) for session-boundary requirements and four-eyes workflows.

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

The built-in `ask_question` tool lets the model pause and ask the user, rather than guessing. It has no `execute` — the model calls it with `{ prompt, options?, allowFreeform? }`:

- `prompt`: the question to put to the user.
- `options`: an optional list of choices to offer. Channels render these as buttons or a select menu.
- `allowFreeform`: whether the user may answer with free text instead of picking an option.

`ask_question` is part of the [default tool set](/docs/concepts/built-in-tools), so it is available without you defining anything. It produces the same `input.requested` pause as an approval, and resumes the same way.

## How pause and resume works

Approvals and questions share one protocol:

1. The model requests input (an approval, or an `ask_question`).
2. eve emits an `input.requested` stream event carrying the pending requests.
3. The turn parks at `session.waiting`, durably, for as long as it takes.
4. The client answers with `inputResponses` (structured, keyed by `requestId`) or a normal follow-up `message`. A follow-up whose text matches an option ID, option label, or numeric option index resolves automatically, including approval options such as `approve` and `cancel`.

Each request includes a `kind` discriminator: `tool-approval`, `question`, or
`session-limit`. Clients should use `kind` to choose behavior and presentation;
`toolName` and `requestId` identify the action and request but do not encode its
semantics.

The run picks back up exactly where it parked. Because the pause is durable, nothing is held in memory while it waits — the process can restart and the parked turn survives.

When a background subagent requests input, eve emits the same `input.requested` event on its parent session. Answering through that parent session routes the response directly to the blocked child without invoking the parent model.

For approval requests, unrelated follow-up text does not deny the tool call. eve keeps the approval pending and records that pending state in model-visible session history. Follow-up turns may answer with text, but cannot call tools until the approval is resolved. Once it is answered, normal tool use resumes and eve settles the original tool call exactly once.

See [Sessions, runs & streaming](/docs/concepts/sessions-runs-and-streaming) for the full event and resume contract that this builds on.

## Answering from a client or channel

Channels turn requests into native UI: the Slack adapter renders approvals as buttons and questions as select menus, and writes the user's choice back as the answer. You get this for free on every [channel](/docs/channels/overview).

From your own frontend, scan all messages for pending requests and answer through the same session — see [Building a frontend](/docs/guides/frontend/overview#human-in-the-loop-prompts) for the client-side reducer and `inputResponses` shape.

## What to read next

- [Tools](/docs/tools): define the typed actions an approval gates
- [Built-in tools](/docs/concepts/built-in-tools): the default tools, including `ask_question`
- [Sessions, runs & streaming](/docs/concepts/sessions-runs-and-streaming): the event and resume contract behind the pause
- [Building a frontend](/docs/guides/frontend/overview): render and answer requests from your own UI
- [Multi-tenant approvals](/docs/patterns/multi-tenant-approvals): resolve per-tenant approval policy for authored and connection tools
