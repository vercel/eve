---
issue: "TBD (maintainer-requested 1.0 research; related #6148)"
status: proposed
last_updated: "2026-11-09"
---

# Multiplayer steering and ambient credentials

## Problem

**A person's access acted on a request they never made.** In a shared Slack
thread, Alice asks a coding agent to fix a flaky test. Her turn ends before
the agent opens a pull request. Later Carol, who never addressed the agent,
writes "flaky :(" in the thread. The agent follows the thread, so her message
starts a new turn as Carol. The model sees Alice's unfinished request, and it
pushes a branch and opens the PR with Carol's GitHub access.

Nothing escalated, because Carol is allowed to open that PR. Using Alice's
access would have been worse: anyone in the thread could then drive it. But
Carol's credentials still acted because she spoke near the agent, not because
she asked it for anything. The channel knew her message was ambient. The
agent's channel hook even stamped that on her auth attributes. But user-scoped
credential resolution (`runtime/connections/principal.ts:79–119`) never looks
at how a message arrived, so the wrong outcome was the default one.

**Shared threads stall.** Only a turn's own principal steers it
(`execution/session/input-queue.ts:293–302`), and `continueTurnAuth` refuses
any principal change within a turn (`execution/session/principal.ts:44–54`).
Everyone else waits behind a long build, a running task, or a pending sign-in
(#6148). eve should always steer and never queue.

Queueing doesn't fix the first problem. Carol's turn was a new turn, not a
steered one, and a queued turn sees the earlier history anyway.

## Guarantee

**Ambient input never releases a person's credentials.** A step that answers a
message its author didn't address to the agent can't use that author's
user-scoped access. The step fails closed with an error the model can act on.

This is narrower than "the agent does only what a person intended." Even an
addressed message can be misread, so destructive actions still need approval
policies. The guarantee covers the boundary eve can enforce mechanically: no
one's access acts just because they spoke nearby.

## Addressed messages

Every accepted human message carries `addressed: boolean`.

| Channel                           | Addressed                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Slack (threads and code channels) | A mention or a DM, or a reply from the person the agent's latest message answered, when nobody else has written since |
| `eveChannel`, `source.send`       | `true` unless the sender passes `addressed: false`                                                                    |
| Other built-in channels           | A mention or DM, in each channel's terms                                                                              |
| Authored channels                 | `true` unless the channel passes `addressed: false`                                                                   |

Slack's reply rule follows conversational turn-taking. Alice can answer the
agent without mentioning it, but once someone else writes in between, she
mentions it again. In a code channel opened for Alice's request, her follow-ups
are addressed, and Carol's remark after the agent answered Alice is not. Edits
are classified by their current text, so removing a mention makes the message
ambient. (`isBotMentioned()` also reports a removed mention, for hook routing,
at `public/channels/slack/slackChannel.ts:1909–1914`. Classification uses the
current text.) A built-in channel that can't classify a message marks it
ambient.

Channel hooks can lower `addressed` to `false` but never raise it. Raising it
would let a hook release credentials.

## Caller snapshot

Each model call runs with one immutable caller snapshot:
`ctx.session.auth.current` plus a new `ctx.session.auth.addressed`.

| Step input                                                                          | Snapshot                                                       |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| New human messages, alone or batched                                                | The latest message's author and its `addressed` flag           |
| No new human message: tool results, task settlements, a resumed sign-in or approval | Unchanged from the previous step                               |
| A message that only answers an open request (button, structured, or typed)          | Unchanged. The responder is recorded on the request, as today. |
| An answer that also carries a message for the model                                 | That message's author and flag                                 |

- Calls keep the snapshot of the step that emitted them, even if a steering
  message arrives while they run.
- Tasks, workflow tools, and subagents inherit the snapshot of the step that
  started them.
- eve records each snapshot durably, so replay binds the same credentials.
- Batching keeps each message's author. Today `coalesceDeliveries` keeps only
  the latest envelope's auth (`harness/messages.ts:445–494`).
- The model's input attributes every human message with its sender and
  `addressed`. Slack already includes the sender and `mentioned:`
  (`public/channels/slack/model-context.ts`).

An ambient follow-up from the same person clears `addressed`, because the
snapshot comes from the latest message alone.

## Credential gate

When a step's snapshot has `addressed: false`, eve resolves no user-scoped
credential for it. That covers tool calls, `ctx.getToken`, `ctx.requireAuth`,
MCP and OpenAPI connection setup and requests, and dynamic connections. The
gate sits in token retrieval (`runtime/connections/scoped-authorization.ts`).
`resolveConnectionPrincipal` stays a pure identity projection.

The call fails with a non-retryable error:

```text
ConnectionAuthorizationFailedError reason: "ambient_caller"
"Carol didn't address the agent in the message this step answers, so it can't
use Carol's GitHub access. Ask the person who wants this done to mention the
agent."
```

No consent prompt is posted, and the turn doesn't hold. The model replies,
stays silent, or asks the right person to address it.

Not affected:

- **App credentials** (`principalType: "app"`) use the agent's own access.
  Approval policies govern them, as today.
- **Anonymous callers** have no user credentials.
- **Unattended execution** keeps its existing identity rules: markdown
  schedules run as the app, dynamic schedule subscriptions reauthorize their
  creator, and connection-event callbacks bind the watch creator. If a thread
  message later steers such a turn, the gate applies to the steps it starts.

### Allowing ambient use

An author who wants a connection usable from ambient messages says so
explicitly, on an eve-owned surface:

```ts
// One credential lookup (ToolAuthOptions)
await ctx.getToken(provider, { ambient: "allow" });

// A connection's tools: an `ambient` option on the eve connection definition
```

`ambient` is `"deny"` (the default) or `"allow"`, and it applies only to
user-scoped auth. Approval policies don't affect it. A policy that returns
`"approved"`, including `auto()` (`tools/approval/policies.ts:62`) and
`once()` (`:101`), approves the action, not ambient use of a credential.
`connect()` from `@vercel/connect/eve` is unchanged.

Tools that bring their own credentials are outside eve. They should read
`ctx.session.auth.addressed` and apply the same rule.

## Steering

Every human message steers the running turn and sets the next step's snapshot.

| Input during a turn                          | Result                                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Addressed message from anyone                | Steers. Pending approvals are withdrawn, as a steer does today (`harness/hitl/approvals.ts:286–306`). A held sign-in is withdrawn as `withdrawn`, not `declined`, so later sign-ins in the turn still work (#6148). |
| Ambient message from anyone                  | Steers as context. Held sign-ins and pending approvals stay pending.                                                                                                                                                |
| Answer to an open request                    | Settles it as its responder, as today.                                                                                                                                                                              |
| Delivery with explicit `turnPolicy: "queue"` | Queues, as today. Connection events use this.                                                                                                                                                                       |
| Delegated caller mismatch (`callerCallId`)   | Queues, as today. This is routing, not identity.                                                                                                                                                                    |

The only admission change is removing the principal check from
`isSteeringDelivery` and `continueTurnAuth`. The default `turnPolicy` is
already `"steer"`. This plan doesn't change who may send cancel, `reset`, or
`clear`.

## Scenarios

| Scenario                                                                     | Snapshot         | Result                                                                                                           |
| ---------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Incident: Carol's ambient "flaky :(" resumes Alice's request                 | Carol, ambient   | The push fails with `ambient_caller`. The agent asks Alice to mention it. Alice does, and the PR opens as Alice. |
| A passing remark would run an earlier request on the speaker's access        | Speaker, ambient | Fails closed.                                                                                                    |
| Carol's ambient question needs a read of her Notion                          | Carol, ambient   | Fails closed, unless the connection sets `ambient: "allow"`.                                                     |
| Alice replies right after the agent answers her, without a mention           | Alice, addressed | Runs as Alice.                                                                                                   |
| Alice replies after Bob writes in between, without a mention                 | Alice, ambient   | Fails closed. She mentions the agent.                                                                            |
| Bob mentions the agent mid-turn to ask for a Snowflake table he can't access | Bob, addressed   | Runs as Bob, and Snowflake denies it.                                                                            |
| Alice asks for a feature, and Bob's ambient comment clarifies it             | Bob, ambient     | GitHub writes fail closed until Alice or Bob addresses the agent.                                                |
| Alice asks for a feature, and Bob mentions the agent to clarify              | Bob, addressed   | The PR opens as Bob. See [Follow-ups](#follow-ups).                                                              |
| Carol writes "lol" while Alice's turn waits on her sign-in                   | Carol, ambient   | The sign-in stays pending.                                                                                       |
| Bob mentions the agent while Alice's sign-in is pending                      | Bob, addressed   | The sign-in is withdrawn, and the turn continues for Bob.                                                        |
| A write with an app credential                                               | Any              | Approval policies apply.                                                                                         |

## Compatibility

These changes break the current contract, so they ship in 1.0:

- `auth.current` becomes per step: the author of the latest human message.
  Update the per-turn promise in `docs/guides/auth-and-route-protection.md`,
  `docs/concepts/security-model.md:78–80`,
  `docs/concepts/sessions-runs-and-streaming.md:335–339`, and
  `docs/tools/tasks.md:220`.
- Other principals' messages steer instead of queueing.
- Ambient steps fail closed for user-scoped credentials where they succeed
  today.

Deliveries without `addressed` count as addressed. That covers authored
channels, persisted pre-1.0 deliveries, and older forwarding peers, and it
matches today's behavior. Built-in channels that deliver unmentioned messages
set the flag themselves, so the incident's path fails closed.

## Follow-ups

These are additive, so they can ship in a 1.x minor once a real author needs
them:

- **Credentials bound to the turn's owner.** The shared-coding case: Alice
  asks, Bob clarifies, and the PR should open as Alice. This needs
  `auth.owner`, a way to choose the owner's credential, and an exact-call
  approval from the owner. It also needs a rule for resolving resources such
  as dynamic connection instances for the chosen person. Until then, the PR
  opens as whoever directed the step, which is safe.
- **An `ambient: "ask"` mode** that requests an exact-call approval from the
  credential's owner instead of failing closed, with a defined lifecycle for
  absent or unreachable people.
- **Owner-targeted questions** for `ctx.ask` and `ask_question`.
- **Multiple co-authors** in the git extension's `attribution`.

## Alternatives considered

- **Consent cards for every ambient credential use.** They prompt people who
  may not be present and need a request lifecycle. They also raise questions
  about how long consent lasts and how it combines with approvals. Failing
  closed gives the same protection with none of that.
- **Approval policies as the opt-out.** Existing policies return `"approved"`
  for unrelated reasons, so they would silently waive the gate.
- **Fix it in the agent's instructions.** It would help, but it's a prompt
  against a model, and every agent would have to get it right.
- **Turn off passive listening.** It removes the trigger, not the gap.
- **Treat anyone who once addressed the agent as addressed.** That reopens the
  passing-remark case for every earlier participant.
- **Code channels as always addressed.** It would let the incident happen in a
  code channel. Turn-taking already covers code-channel conversation.
- **Keep queueing.** It doesn't stop the incident, and it stalls threads.

## Testing

- Unit and integration: snapshot transitions (batching, answers, edits, steps
  without new messages, replay, inherited snapshots) and the gate across
  `ctx.getToken`, connection tools, and MCP setup.
- One deterministic e2e eval with a mock model that replays the incident: an
  ambient message resumes earlier work, the write fails with `ambient_caller`,
  and an addressed message then succeeds.

## Decisions

1. Reads get no exception. The opt-out is `ambient: "allow"` on the credential,
   not an approval policy.
2. Slack classifies unmentioned replies by turn-taking, in threads and code
   channels alike.
3. 1.0 adds one identity field, `ctx.session.auth.addressed`. `owner`,
   `contributors`, and `actAs` are follow-ups.
4. Ownership doesn't transfer, because 1.0 has no owner-bound credentials.
5. This plan doesn't change who may send controls.
6. There are no consent grants, because there are no consent prompts.
7. Steering by any principal is the default in 1.0.
