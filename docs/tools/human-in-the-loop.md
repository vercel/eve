---
title: "Human-in-the-loop"
description: "Pause a run for a person — gate a tool on approval or have the agent ask a question — and resume durably when they answer."
url: /human-in-the-loop
---

Human-in-the-loop (HITL) is any point where the agent durably pauses and waits for a person. Two things trigger it, and both ride the same pause-and-resume protocol:

- **Approvals** — a tool requires a person to sign off before (or instead of) running. The agent decides to call the tool; a human decides whether it does.
- **Questions** — the agent itself asks the user a clarifying question or a choice mid-turn, and parks until they answer.

Either way the run parks at `session.waiting`, durably, for as long as it takes — seconds or days — and picks back up exactly where it left off once the answer arrives. Channels render the request for you.

## Approvals

Approval is a property of a [tool](/docs/tools) that pauses for a person before it runs. Gate a tool with `needsApproval` and the helpers from `eve/tools/approval`:

```ts title="agent/tools/refund_charge.ts"
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Refund a charge.",
  inputSchema: z.object({ chargeId: z.string(), amount: z.number() }),
  needsApproval: always(), // or once() / never() / a predicate
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

By default, omitted `needsApproval` behaves like `never()`, so tool calls may execute without human approval. Require human approval or other safeguards for sensitive, irreversible, regulated, financial, healthcare, employment, housing, legal, safety-impacting, user-impacting, or external side-effecting actions.

When the decision depends on the input, pass your own predicate instead of a helper. It receives `{ toolName, toolInput, approvedTools }` and returns a boolean. `toolInput` can be undefined, so guard the access. To require approval only when an amount crosses a threshold:

```ts
needsApproval: ({ toolInput }) => (toolInput?.amount ?? 0) > 1000,
```

Gating a side effect on approval is also how you make non-idempotent work safe across replays: a charge or email that sits behind `always()` can't fire from a re-run step without a fresh human decision.

## Questions

The built-in `ask_question` tool lets the model pause and ask the user, rather than guessing. It has no `execute` — the model calls it with `{ prompt, options?, allowFreeform? }`:

- `prompt`: the question to put to the user.
- `options`: an optional list of choices to offer. Channels render these as buttons or a select menu.
- `allowFreeform`: whether the user may answer with free text instead of picking an option.

`ask_question` is part of the [default harness](/docs/concepts/default-harness), so it is available without you defining anything. It produces the same `input.requested` pause as an approval, and resumes the same way.

## How pause and resume works

Approvals and questions share one protocol:

1. The model requests input (an approval, or an `ask_question`).
2. eve emits an `input.requested` stream event carrying the pending requests.
3. The turn parks at `session.waiting`, durably, for as long as it takes.
4. The client answers with `inputResponses` (structured, keyed by `requestId`) or a normal follow-up `message`. A follow-up whose text matches an option label (case-insensitive) resolves automatically.

The run picks back up exactly where it parked. Because the pause is durable, nothing is held in memory while it waits — the process can restart and the parked turn survives.

See [Sessions, runs & streaming](/docs/concepts/sessions-runs-and-streaming) for the full event and resume contract that this builds on.

## Answering from a client or channel

Channels turn requests into native UI: the Slack adapter renders approvals as buttons and questions as select menus, and writes the user's choice back as the answer. You get this for free on every [channel](/docs/channels).

From your own frontend, read the pending request off the latest message and answer through the same session — see [Building a frontend](/docs/guides/frontend/overview#human-in-the-loop-prompts) for the client-side reducer and `inputResponses` shape.

## What to read next

- [Tools](/docs/tools): define the typed actions an approval gates
- [Default harness](/docs/concepts/default-harness): the built-in tools, including `ask_question`
- [Sessions, runs & streaming](/docs/concepts/sessions-runs-and-streaming): the event and resume contract behind the pause
- [Building a frontend](/docs/guides/frontend/overview): render and answer requests from your own UI
