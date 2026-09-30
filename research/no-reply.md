---
issue: https://github.com/vercel/eve/issues/4061
status: proposed
last_updated: "2026-09-30"
---

# Built-in `no_reply` tool

## Decision

Add a built-in `no_reply` tool that ends the turn without a final reply. An agent's instructions
alone can then make a scheduled run whose condition isn't met, or a Slack turn where a reaction is
the whole answer, post nothing, with no renderer code.

```ts
no_reply({ reason?: string })
```

`reason` explains the decision for traces, evals, and logs. eve never delivers it.

```ts title="agent/schedules/critical-alerts.ts"
import { defineSchedule } from "eve/schedules";

import slack from "../channels/slack";

export default defineSchedule({
  cron: "0 * * * *",
  async run({ to, waitUntil, appAuth }) {
    waitUntil(
      to(slack, { channelId: "C0123ABC" }).send(
        "Summarize the critical alerts opened in the last hour. If there are none, call no_reply.",
        { auth: appAuth },
      ),
    );
  },
});
```

This is ask 2 of #4061. It supersedes #2386 and #2388.

## Background

#248 added `<eve-empty-delivery/>`: a reply containing the marker was suppressed. #3160 limited
suppression to replies that were only the marker, and #3840 removed the marker with background
tasks. `task_wait` covers interim text while tasks work, but a turn with no tasks has no way to post
nothing today:

- A final step with no text and no tool calls raises `EmptyModelResponseError`, and eve reissues
  the call once with a nudge to continue (`harness/tool-loop.ts`). An empty reply is treated as a
  failed model call, not as silence.
- Apps that still need silence strip their own marker in a custom renderer. #2388 records a
  production run where a misspelled marker and the retry's filler text were both posted.

## Availability

| Session or turn                                            | `no_reply` offered |
| ---------------------------------------------------------- | ------------------ |
| Root session turn, including channel and schedule sessions | Yes                |
| Subagent, `agent` tool child, or other delegated session   | No                 |
| Turn that requests structured output (`outputSchema`)      | No                 |

A delegated session's parent expects the reply as the call's output, so an empty result would be a
silent failure. A structured-output turn must end with `final_output`. Delegated sessions already
hide root-only tools (`harness/advertised-tools.ts`); `no_reply` uses the same rule.

`no_reply` is a default tool in the `agent/tools/no_reply.ts` slot. `disableTool()` in that slot or
`defaultTools: false` removes it. The tool list stays the same for every turn of a session, so the
cached prompt prefix is kept. Structured-output turns are the one exception, and their tool list
already changes because they add `final_output`.

## Semantics

A turn that calls `no_reply` completes normally. It emits `turn.completed` and `session.waiting`,
and no final `message.completed`.

```text
turn.started
message.completed { finishReason: "tool-calls" }   only if the model wrote text first
turn.completed                                     no final message.completed
session.waiting
```

- **Earlier text is interim.** Text the model streams in the step that calls `no_reply` is reported
  with `finishReason: "tool-calls"`, whatever the provider reports, so no channel posts it as the
  reply. Streaming surfaces may already show it, as with any text before a tool call, so the tool
  description tells the model to call `no_reply` without writing text first.
- **Other calls in the step settle first.** Inline tool calls made in the same step run to
  completion, then the turn ends. The model does not see their results in this turn.
- **The turn can't end while work is pending.** When tasks are working, or the same step starts a
  workflow call or task or waits on a question, approval, or sign-in, eve answers the call with an
  error result and the turn continues. This mirrors how `final_output` is rejected while tasks work.
- **History keeps the decision.** The session history records the `no_reply` call, with any text
  before it, followed by the tool result `No reply was sent.` A later turn sees that the agent
  stayed quiet on purpose.
- **Channels never render the call.** `no_reply` emits no `actions.requested` or `action.result`,
  as with `final_output`, so no channel shows it as tool activity.

The tool has no `execute`. Like `final_output`, the tool loop recognizes the call when it decides
whether to continue or end the turn, and the mock model adapter calls `no_reply` when the prompt
names it, so deterministic suites can cover it.

## Delivery surfaces

Every built-in channel already skips `message.completed` events with no text or with
`finishReason: "tool-calls"`, and posts nothing when no final `message.completed` arrives. One
channel needs a change; one needs a decision.

| Surface                         | Behavior after `no_reply`                                                   |
| ------------------------------- | --------------------------------------------------------------------------- |
| Slack                           | No post. Needs a change: clear the thread status (see below).               |
| Discord, Telegram, Teams        | No post. The typing indicator from `turn.started` expires on its own.       |
| Twilio                          | No message.                                                                 |
| GitHub                          | No comment. The `eyes` reaction from `turn.started` stays.                  |
| Linear                          | No `response` activity; only the ephemeral `thought`. See open questions.   |
| Chat SDK                        | No new message. Text streamed before the call stays as streamed narration.  |
| HTTP client (`eve` channel)     | `result()` resolves with `status: "completed"` and `message: undefined`.    |
| Schedules, `to(channel).send()` | The target channel's handlers apply, so the rows above hold.                |
| Markdown schedules              | Output is already discarded; the stream shows no final `message.completed`. |

Slack's default renderer sets `Working...` on `turn.started` and relies on the posted reply, or an
empty final `message.completed`, to clear it. Slack clears a status only after two minutes without a
message, so the default renderer should clear the thread status on `turn.completed`.

## Alternatives considered

**Restore the marker in core.** Rejected:

- It fails open. A misspelled or reformatted marker is posted as literal text (#2388), and tolerant
  matching (#2386) only widens the set of spellings it catches.
- Streaming channels send deltas before the reply is complete, so a marker can be partly visible
  before eve detects it.
- An empty reply is retried with a nudge to continue the request, which works against a model that
  meant to stay quiet. In #2388 the retries produced filler that was posted.
- The marker stays in history as assistant text, so every later model call and eval must strip or
  tolerate it.

A tool call is structured, validated by the provider, and never part of the reply text, so none of
these apply.

**Treat an empty final reply as silence.** Rejected. The empty-response retry exists because a blank
step is ambiguous, and dropping it would hide failures, including a dropped reply after a person
answers a question. `no_reply` keeps the retry and makes silence an explicit choice.

## Documentation

- `docs/concepts/built-in-tools.md`: a `no_reply` section covering availability, semantics, and how
  to disable it.
- `docs/schedules.mdx`: replace "check that condition in the handler before calling `send`" with
  instructions that tell the agent to call `no_reply`. A handler can still skip `send` when code can
  decide the condition without the agent.
- `docs/channels/slack.mdx`: note that a turn that ends with `no_reply` clears the thread status and
  posts nothing.

## Validation

- **Unit:** the continue-or-terminate branch ends the turn on `no_reply`; the step's text reports
  `finishReason: "tool-calls"`; the call is rejected while tasks work and when the step also parks;
  history ends with the call and its `No reply was sent.` result; `no_reply` is hidden in delegated
  sessions and on structured-output turns.
- **Integration:** a Slack channel session whose turn calls `no_reply` posts nothing and clears the
  status, and an HTTP `result()` resolves with `message: undefined`.
- **E2E, deterministic:** a schedule in `e2e/fixtures/agent-schedules` whose condition isn't met
  completes with no final `message.completed` on its stream, under the mock model in the world
  suites. The fixture has no channel, so the stream is the observable.
- **E2E, real model:** in a conversation where a reaction is the whole answer, the turn completes
  with no message; a plain question gets a normal reply. Eval tool calls come from action events,
  which `no_reply` doesn't emit, so the eval asserts on `status` and `message`.

## Open questions

- Should `turn.completed` say that no reply was sent, so clients and evals can tell `no_reply` from
  other turns without a final message, such as a content-filtered step?
- Should Linear offer `no_reply` at all, or post a closing activity, since a Linear Agent Session
  otherwise ends without a `response`?
- Should `agent/tools/no_reply.ts` accept a replacement definition, or only `disableTool()`, given
  the terminal behavior belongs to the tool loop?
- Should a remote agent's session, which is a root session on its own deployment, offer
  `no_reply` when a parent calls it as a subagent?
