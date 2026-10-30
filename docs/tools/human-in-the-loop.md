---
title: "Human-in-the-Loop"
description: "Pause a run for a person — gate a tool on approval or have the agent ask a question — and resume durably when they answer."
url: /human-in-the-loop
---

Human-in-the-loop (HITL) is any point where the agent pauses and waits for a person. Two things cause a pause:

- **Approvals**: a tool's `approval` policy allows, denies, or holds a call for a person to review.
- **Questions**: the agent asks the user a clarifying question or a choice in the middle of a turn.

The turn stays open and the stream reports `turn.paused`. The wait survives process restarts, so it can last seconds or days. When the answer arrives, the run continues where it stopped.

## Approvals

Set `approval` on a [tool](/docs/tools), including a [workflow tool](/docs/tools/workflows), to check each call before it runs. Use the helpers from `eve/tools/approval`:

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

Rules:

- A call that waits for approval hasn't started, and a denied call never runs.
- Other calls from the same model response that need no approval run while it waits.
- Omitted `approval` behaves like `never()`, so tool calls run without human approval by default. Require human approval or other safeguards for sensitive, irreversible, regulated, financial, healthcare, employment, housing, legal, safety-impacting, user-impacting, or external side-effecting actions.
- Approval doesn't make a charge or email happen exactly once. Give non-idempotent side effects their own idempotency keys.
- Approval is consent only. The approved call, its policy recheck, and the rest of the turn run with the requesting user's identity, connections, and credentials, never the approver's. See [Act as the approver](#act-as-the-approver).

### Let a decision model review calls

`auto()` sends each call to an [AI SDK decision model](/docs/guides/decide), which classifies it as `clear` or `caution`. A `clear` call runs. A `caution`, a failed review, or incomplete input requires user approval. The tool name and input go to the decision model's provider.

Omit `model` to use `typesafe-ai/jev`, TypeSafe AI's [Jev decision model](https://vercel.com/i/what-is-jev). As with `decide`, a model string uses Vercel AI Gateway unless the application configures a global AI SDK default provider:

```ts
approval: auto({ model: "typesafe-ai/jev" });
```

Override the classifier text for an application-specific policy:

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

A dynamic tool rebuilds its policy each time eve evaluates the tool. To keep external data that configures a policy, save it with [`ctx.memo()`](/docs/guides/dynamic-capabilities).

### Customize the approval prompt

Use the object form of `approval` to replace the default `Approve <tool label>?` text. The `prompt` callback receives the validated `input`, final `toolName`, and `callId`:

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

Channels show this prompt in their approval UI. Slack also shows the complete tool input in a collapsed **Tool input** block.

### Write your own policy

When the decision depends on the input, pass a function. It receives `session`, the same as `ctx.session` in `execute`, plus `{ toolName, toolInput, callId, abortSignal }`. Connection tools also get `toolAnnotations`.

This policy denies cross-tenant calls, then requires approval only above an amount:

```ts
approval: ({ session, toolInput }) => {
  const callerTenant = session.auth.current?.attributes.tenantId;
  if (callerTenant === undefined || callerTenant !== toolInput?.tenantId) {
    return { type: "denied", reason: "Caller cannot access this tenant." };
  }
  return (toolInput?.amount ?? 0) > 1000 ? "user-approval" : "not-applicable";
},
```

The policy returns an `ApprovalStatus`, directly or as a promise:

| Return                        | Result                                     |
| ----------------------------- | ------------------------------------------ |
| `"user-approval"` or `true`   | Pause for a person.                        |
| `"not-applicable"` or `false` | Continue without a prompt.                 |
| `"approved"`                  | Run the call without a person.             |
| `"denied"`                    | Deny the call without a person.            |
| `{ type: "denied", reason }`  | Deny the call and give the model `reason`. |

When you write a policy:

- Pass `abortSignal` to asynchronous work, so the work stops with the turn.
- Check `session.auth.current` for the caller of the current turn, or `session.auth.initiator` for the caller that started the session.
- Handle a `toolInput` of `undefined`.

A denied call never starts, including when the policy denies an approved call on its recheck. Its `call.settled` event has `outcome: "rejected"`, `cause: { policy: "approval" }`, and a `TOOL_EXECUTION_DENIED` output. A tool that runs and throws ends with `outcome: "failed"` instead.

The `call.started` event records what let the call run in `clearedBy`:

| Cleared by                                   | `clearedBy`              |
| -------------------------------------------- | ------------------------ |
| A policy returning `"approved"`              | `{ policy: "approval" }` |
| A remembered `once()` approval               | `{ policy: "approval" }` |
| A person                                     | `{ interactionId }`      |
| Nothing, because the call needed no approval | omitted                  |

The `Approval`, `ApprovalConfiguration`, `ApprovalContext`, `ApprovalPolicy`, and `ApprovalStatus` types are exported from `eve/tools/approval`.

### Remember approval for a tool

`once()` remembers the latest answer to its prompts for the tool's final name, across turns and context clears, until the session ends. A remembered approval covers later calls to that tool, whatever their input.

- A later denial of a `once()` prompt replaces the approval, so the next call asks again.
- When one message answers several of those prompts, a denial among the answers wins.
- A `once()` approval covers later calls, not other approvals already waiting. Each waiting approval needs its own answer.

eve remembers only prompts that `once()`'s own status asked for. It remembers nothing for an `always()` prompt, or for a wrapping policy that calls `once()` but returns a different status. When you wrap `once()`, pass the policy context through and return its status object unchanged.

A remembered approval is consent, not authorization. Authorize the current caller on every call. Use `always()` or an input-dependent policy when different tenants, environments, or other inputs need separate approval decisions.

### Authorizing approval responses

By default, only the person whose turn requested a call can approve or cancel it.

Define a `response` policy to change who can answer, such as a list of designated approvers. The policy replaces the default entirely, so return `{ status: "allowed" }` to accept any responder:

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

- `request`: the call's `interactionId`, `callId`, `toolName`, and typed `toolInput`. `request.principal` is the signed-in user whose turn requested the call, or `null` for an unauthenticated or anonymous caller. It is fixed when the approval opens, even if other people continue the session.
- `response`: the submitted `decision` (`"approve"` or `"deny"`) and the responder's `principal` from your route or channel. `principal` has `principalId`, `principalType`, `authenticator`, and `attributes`.
- `session`: read-only `id`, `initiator`, `parent`, and `turn`.
- `auth`: `getToken(provider, options?)` and `requireAuth(provider, options?)` for the responder, for checks that depend on a provider identity or permission. If the responder must sign in, eve waits for sign-in and then runs the policy again.

The policy runs for both decisions, so a rejected responder can neither approve nor deny. `{ status: "rejected", reason }` keeps the request open for another eligible responder. When a policy only checks who approves, allow every `deny`, so anyone can dismiss the request.

In a shared thread, `session.initiator`, who started the session, can differ from `request.principal`, who asked for this call. To let only the requester answer, compare every identity field of the two:

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

When the policy refuses an answer, `response.settled` reports `outcome: "refused"` and the approval stays open. Submitting an answer doesn't finish the call by itself, so wait for `interaction.settled` to confirm a decision.

#### Act as the approver

A `defineTool` tool can act for the approver explicitly. While an approved `defineTool` call runs, `ctx.approval.responder` is the approver, and `ctx.session.auth.current` stays the requester. `ctx.approval.responder.getToken(provider)` returns the approver's token for an inline provider. `ctx.approval` is absent in workflow tools and for calls that needed no approval.

`ctx.approval.responder.getToken(provider)` never starts a sign-in. When the approver has no token, it throws a `ConnectionAuthorizationFailedError` with `reason: "approver_authorization_required"`.

A connection's `headers` and `toolCall.providedArguments` callbacks receive the same `ctx.approval.responder` while an approved connection call runs. See [Send the approver to the server](/docs/connections#send-the-approver-to-the-server).

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

Traces record both people:

| Span     | Attributes                                                     | Names                            |
| -------- | -------------------------------------------------------------- | -------------------------------- |
| Turn     | `agent.principal.current.*`                                    | The requester                    |
| Approval | `agent.approval.responder.type`, `agent.approval.responder.id` | The person who answered          |
| Tool     | `agent.tool.approver.type`, `agent.tool.approver.id`           | The approver of an approved call |

The ids are recorded only when the trace policy records both inputs and outputs, and the conversation is public or runs in development. Otherwise, only the type is recorded.

### Skipping approval for schedule-dispatched turns

Markdown schedules run as the app: `authenticator: "app"`, `principalId: "eve:app"`, and `principalType: "runtime"`. A `run` schedule must pass its `appAuth` to `send(...)` for the child session to run as the app. To skip approval for scheduled turns but still ask a person, match all three fields on `session.auth.current`:

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

If a person later continues a schedule-started session, `session.auth.current` becomes that person. `session.auth.initiator` stays the app, so check `initiator` only when the policy should cover the whole session. Pair this pattern with idempotency keys or `once()`, because a non-idempotent side effect runs again if a step replays.

## Questions

The opt-in `ask_question` tool lets the model pause and ask the user one question instead of guessing. Add it with `eve add tool/ask_question`, which creates this file:

```ts title="agent/tools/ask_question.ts"
import { askQuestion } from "eve/tools/ask_question";

export default askQuestion;
```

The model calls `ask_question` with `{ question, options? }`:

- `question`: the question for the user, with the context needed to answer it.
- `options`: two or three mutually exclusive choices, each with a `label` and a one-sentence `description`. Channels show these as buttons or a select menu. Omit `options` for an open-ended question.

The user can always type their own answer, so the model never needs an "Other" option. The tool returns:

| Result                           | When                                                      |
| -------------------------------- | --------------------------------------------------------- |
| `{ status: "answered", answer }` | The user picked an option (its label) or typed an answer. |
| `{ interrupted: true }`          | A new message arrived that didn't answer the question.    |
| `{ status: "unavailable" }`      | The session can't request input.                          |

Without any asking tool, the model asks in its reply text, and the user's next message carries the answer.

`ask_question` is an ordinary [workflow tool](/docs/tools/workflows) built on `ctx.ask()`. Write your own with `ctx.ask()` when you need a different schema or want to act on the answer in the same call.

An answered `ctx.ask()` returns `responder`, when available: the signed-in responder's `id`, `type`, and optional `issuer`, without channel attributes. Use `responder`, not `ctx.session.auth.current`, to identify who answered.

## Answering from a client or channel

Every [channel](/docs/channels/overview) turns requests into native UI and sends the user's choice back as the answer. Slack, for example, shows approvals as buttons and questions as select menus.

In your own frontend, use `openInteractions(view)` and `respond([{ interactionId, optionId }])` on the same session. A request stays `open` until its `interaction.settled` event, and you can answer while other work runs. See [Building a frontend](/docs/guides/frontend/overview#human-in-the-loop-prompts).

## How pause and resume works

Approvals and questions pause and resume the same way:

1. A tool call needs approval, or a workflow tool such as `ask_question` calls `ctx.ask()`.
2. eve emits an `interaction.opened` event for each waiting request.
3. The stream emits `turn.paused` for those requests. After the answer, the turn continues with the same `turnId`.
4. The client answers with `answers`, each naming its `interactionId`, or with a follow-up `message`. A message whose text matches an option ID, option label, or option number answers automatically. This includes approval options such as `approve` and `deny`.

To tell the model why you denied a call, send `text` with the `deny` answer: `{ interactionId, optionId: "deny", text: "Only the three-pack." }`. The model gets the note quoted in the denial result, attributed to the person who denied the call. That person may not be the user. Anyone who can read the session stream sees the note in `response.submitted` and `interaction.settled`.

Cancelling the turn ends its approvals as `interrupted`. The call doesn't run, and a later answer approves nothing.

### Follow-up messages

For `ctx.ask()` questions and prompts passed up from subagents, a follow-up message can answer the first open request; see [Several requests at once](#several-requests-at-once). The message answers when it matches an option or the question allows free text. Otherwise, the message follows the session's `turnPolicy`.

A steering message, the default, aborts the `ctx.abortSignal` of each `execute` workflow tool call that the turn waits on. A question from such a call, such as `ask_question`'s, ends as `withdrawn`. The model reads the message after those calls finish.

For approvals, a follow-up message that matches no option steers the turn, even with `turnPolicy: "queue"`, because the turn can't end until the person acts:

- eve withdraws every unanswered approval. The request ends as `withdrawn`, its call ends as `rejected` without running, and the model reads the message next.
- Approvals that already have an answer use that answer, so approved calls still run.
- A message from anyone other than the person the turn serves waits until the turn ends.

### Request kinds

On the stream, each request's `request.kind` is `approval`, `question`, `budget`, or `sign-in`. Its `subject` names the call, task, or turn that the request is about. Clients read the same `request.kind` on an `Interaction` to choose behavior and display. Keep a default branch, because a later release can add a kind.

`interactionId` identifies the request to answer, and `call.callId`, when present, identifies its call. Neither ID encodes what the request means.

### Requests from subagents

When a subagent asks for input, its parent session passes the request on as its own `interaction.opened` event. `origin` names the child session and request, and `origin.call` names the child's call. Answer through the parent session. The answer goes straight to the waiting child, without calling the parent model.

A message from the parent agent never answers a subagent's tool approval or session-limit request, even when its text matches an option. Only a person's structured answer, sent through the parent session, answers these requests. The subagent receives the parent's message as an ordinary message:

- The message steers the turn past a waiting approval, which ends as `withdrawn`.
- The message waits behind a session-limit request until a person answers that request.

### Several requests at once

A turn can wait on more than one request. Examples are two `ctx.ask()` questions from `Promise.all` in a workflow tool, or approvals for two tool calls from one step. A follow-up message answers only the first open request:

1. A [runtime limit](/docs/agent-config#runtime-limits) continuation prompt, if one is open.
2. Otherwise, the oldest request, in the order of its `interaction.opened` events.

The message answers that request when it matches one of its options or the request accepts free text. Otherwise, it follows the rules in [Follow-up messages](#follow-up-messages). To answer several requests by text, send one message per request.

When one step calls both a workflow tool, such as `ask_question`, and an approval-gated tool, the question comes first. eve asks for the approval after the workflow tool call finishes.

Text-only channels show one request at a time, in this order, so a reply answers the request the person sees. These are Twilio, GitHub, Linear, and all Chat SDK channels. Chat SDK can't tell whether an adapter shows buttons, so this includes Linq, Photon, and adapters with buttons. Native channels with buttons, such as Slack, show every open request, and a typed reply still answers the first. A Slack app that sets `onAnswers` or `approvalChannel` accepts answers only through its controls; see [Restrict who can invoke the agent](/docs/channels/slack#restrict-who-can-invoke-the-agent).

## What to read next

- [Tools](/docs/tools): define the typed actions an approval gates
- [Built-in tools](/docs/concepts/built-in-tools): the default tools and opt-in tools such as `ask_question`
- [Sessions, runs & streaming](/docs/concepts/sessions-runs-and-streaming): the event and resume contract behind the pause
- [Building a frontend](/docs/guides/frontend/overview): render and answer requests from your own UI
- [Multi-tenant approvals](/docs/patterns/multi-tenant-approvals): resolve per-tenant approval policy for authored and connection tools
