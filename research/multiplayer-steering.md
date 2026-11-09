---
issue: "TBD (maintainer-requested 1.0 research; related #6148)"
status: proposed
last_updated: "2026-11-09"
---

# Multiplayer sessions: steering, identity, and consent

## Problem

A shared session, such as a Slack thread or code channel, has several people
in it. eve tells a tool only one thing about them, `ctx.session.auth.current`,
and the tool decides whose access to use from that alone. Two failures follow.

**Someone's access acts on a request they never made.** In a shared Slack
thread, Alice asks a coding agent to fix a flaky test. Her turn ends before
the agent opens a pull request. Later Carol, who never addressed the agent,
writes "flaky :(" in the thread. The agent follows the thread, so her message
starts a new turn as Carol. The model sees Alice's unfinished request and
pushes a branch and opens the PR, all with Carol's GitHub access.

Using Carol's access was the right call given what eve exposes today. Using
Alice's would have let anyone in the thread drive Alice's access. Still, a
person's credentials carried out work that person never asked for. Swap the
roles and it gets worse: Bob asks for something dangerous and is refused, and
later someone who holds that permission comments in passing and the request
runs on their access.

The channel knew Carol's message was ambient. The agent's channel hook even
stamped that on her auth attributes. The `gh` tool's only gate was
`authorize: ({ auth }) => auth?.principalType === "user"`, though, and eve's
credential resolution (`resolveConnectionPrincipal`) never looks at how a
message arrived. Every layer did what it was asked, and the wrong thing was
still the easy thing.

**Shared threads stall.** Only a turn's own principal steers it
(`isSteeringDelivery` in `execution/session/input-queue.ts`), and
`continueTurnAuth` refuses any principal change within a turn. Everyone else
waits behind a long build, a running task, or a pending sign-in (#6148). eve
should always steer and never queue, but tools can't do that safely while
they see only one identity.

Queueing doesn't protect data either. A queued turn sees the earlier history
and artifacts (see "What reaches `ctx.session.auth`" in the auth guide). All it
prevents is one person's text driving another person's credentials. This
proposal keeps that guarantee, applies it to every turn and not just steered
ones, and enforces it where credentials are resolved.

## Principle

**A person's access acts only on that person's direction.** eve resolves a
user-scoped credential without asking only when its owner directed the step
that uses it. Otherwise eve asks that person first. A tool author can relax
the rule only by writing an explicit policy. The default is the safe path.

Directing the agent is necessary but not sufficient. Destructive actions
still need approval policies, because a model can misread even an explicit
request.

## Why before 1.0

`ctx.session.auth.current` is a stable API, and the docs promise that "the
caller stays the same for the whole turn." The consent rule also adds prompts
to turns that run silently today. Both changes alter stable behavior, so they
must land before 1.0 or wait for 2.0. Multiplayer steering itself can follow
as an opt-in (see [Rollout](#rollout)).

## Addressed messages

Every human message gets a channel-neutral `addressed` flag: `true` when the
sender is talking to the agent, `false` when the agent just overhears it.

| Channel                     | Addressed                                         | Ambient                                                                      |
| --------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Slack                       | A mention, a DM, or any message in a code channel | A reply without a mention in a followed thread, or a watched-channel message |
| `eveChannel`, `source.send` | Default `true`: the caller sent it on purpose     | When the sender passes `addressed: false`                                    |
| Other platform channels     | A mention or DM, in each channel's terms          | Everything else they deliver                                                 |

Slack already knows the difference (`isBotMentioned()`, the
`app_mention`/`direct_message`/`channel_message` kinds) and puts `mentioned:`
into the model's context. This makes it a delivery fact that credential
resolution can read. An inbound hook can lower `addressed` to `false` but can
never raise it. Raising it would let a hook manufacture consent.

## Identities in a turn

| Field               | Meaning                                                                                          | Incident value |
| ------------------- | ------------------------------------------------------------------------------------------------ | -------------- |
| `auth.initiator`    | Who started the session (unchanged)                                                              | Alice          |
| `auth.owner`        | Whose message started this turn; fixed for the turn (new)                                        | Carol          |
| `auth.contributors` | Everyone whose message joined this turn, owner first (new)                                       | [Carol]        |
| `auth.current`      | The speaker: author of the latest human message in this step's input (redefined)                 | Carol          |
| `auth.directedBy`   | Author of the latest addressed message, if nobody else has written since; otherwise `null` (new) | `null`         |

`auth.current` follows the speaker, so existing readers fail safe: per-user
connections, per-user dynamic definitions, memory recall, and
`message.received` hooks all act for the person whose words the step answers.
With steering limited to the owner, as today, `owner`, `contributors`, and
`current` collapse to one person. `directedBy` is new information even then.

Each model call records its speaker and `directedBy` in durable state, so
replay binds the same credentials. A tool call keeps the values of the step
that emitted it, even if a steering message arrives while it runs.

## Consent rule

When a user-scoped credential resolves, eve compares its subject (the person
whose token it is) with `directedBy`:

```text
subject === directedBy         → resolve, as today
subject !== directedBy         → consent request to the subject, then resolve or fail
access: "read"                 → resolve without consent (see open questions)
principalType: "app"           → not a person's access; approval policies apply
```

A consent request reuses the held sign-in (`research/held-sign-in-and-approval.md`):
the turn holds, and only the subject can answer. The card says what the agent
wants to do and for whom. For example: "The agent wants to push a branch and
open a pull request in `acme/web` as you, continuing a request from Alice.
Allow or Decline." Allowing it counts as an addressed act by the subject.
Declining fails the call with an error the model can act on:

```text
ConnectionAuthorizationFailedError reason: "consent_declined"
"Carol declined to let the agent act as them on GitHub. Ask the person who
requested this to confirm it in the thread."
```

The gate sits where eve resolves user principals. Tool credentials
(`ctx.getToken`, `ctx.requireAuth`, and connection tools) go through
`runtime/connections/scoped-authorization.ts` to `resolveConnectionPrincipal`.
Connection events resolve through `runtime/connections/events/dispatch-step.ts`.
Tools that bring their own credentials are outside eve and must apply the rule
themselves, using the fields above.

Schedules and connection events have no message to address. They run with
standing consent from whoever created the schedule or subscription, and they
act only as that person. A schedule's turn that a thread message later steers
follows the rule as usual.

## Authoring API

### Credential binding and access

```ts
// The defaults, written out
auth: connect({ connector: "acme/snowflake", principalType: "user", actAs: "speaker" });

// One call: read with the owner's access, without a consent prompt
await ctx.getToken(connect("acme/github"), {
  actAs: "owner",
  access: "read",
  purpose: "Read the PR diff",
});
```

- `actAs: "speaker" | "owner"` chooses the subject. `"speaker"` is the default
  and today's behavior.
- `access: "read" | "write"` defaults to `"write"`. Only `"read"` skips
  consent. MCP connection tools default to `"read"` when the server declares
  `readOnlyHint`.
- `purpose` is the sentence on the consent card, in the same form as the git
  extension's `signInReason`.

### Approval policies can pre-approve

The call's approval policy (`ApprovalPolicy`, which already extends
`SessionContext`) sees `owner`, `contributors`, and `directedBy`. Returning
`"approved"` for a call that needs consent skips the prompt. This is the
escape hatch, and it has to be written as code. To check other people,
the policy context gets a public form of the internal `getResponderToken`
(`runtime/authorization-context.ts`), which reads a stored token without
starting a sign-in.

### Owner-targeted questions

Consent requests, and any approval or sign-in raised for a specific subject,
can be answered only by that person, and channels render them that way.
`ctx.ask` and `ask_question` gain the same target, so agents no longer have to
stamp owner ids into Slack card block ids to get owner-only cards.

### Git extension

```ts
export default git({
  github: {
    connector: "acme/github",
    principalType: "user",
    actAs: "owner",
    authorize: ({ auth, owner, contributors, directedBy, repository }) => /* ... */,
    attribution: (ctx) => coAuthorsFor(ctx.session.auth.contributors),
  },
});
```

The extension classifies its own commands. `gh pr view` and `git fetch` are
`access: "read"`. Pushes, `gh-signed-commit`, `gh pr create`, and changing
`gh api` calls are `"write"`, and unknown commands default to `"write"`.
`attribution` may return several co-authors, so a PR that Bob shaped
credits him.

## Steering

With multiplayer steering on, any principal's message steers, and the consent
rule decides what that step may do with whose access:

| Input during a turn                               | Result                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Message from the owner                            | Steers, as today.                                                                            |
| Message from another principal                    | Steers. They join `contributors` and become the speaker from the next step on.               |
| Another principal's message during a held sign-in | Steers and withdraws the held sign-in as `declined` (#6148). Pending approvals stay pending. |
| Answer to an open request                         | Settles it as its responder without changing the speaker, as today.                          |
| Delegated caller mismatch (`callerCallId`)        | Queues, as today. This is routing, not identity.                                             |

Tasks and subagents bind the speaker and `directedBy` of the step that starts
them. Input a later step sends them carries that step's values. Each steering
message from another principal is attributed in the model's input, with
sender and `addressed`.

## Scenarios

| Scenario                                                                     | Subject | `directedBy` | Result                                                                                   |
| ---------------------------------------------------------------------------- | ------- | ------------ | ---------------------------------------------------------------------------------------- |
| Incident: Carol's ambient "flaky :(" leads to a push and a PR                | Carol   | `null`       | Carol is asked. She declines, and the model asks Alice to confirm in the thread.         |
| Someone remarks in passing, and an earlier request would run on their access | Them    | `null`       | They are asked before their access is used.                                              |
| Bob steers and asks for a Snowflake table he can't access                    | Bob     | Bob          | The query runs as Bob, and Snowflake denies it.                                          |
| Alice asks for a feature, Bob clarifies, PR with `actAs: "owner"`            | Alice   | Bob          | Alice is asked, unless the policy approves because every contributor can write the repo. |
| Alice mentions the agent alone                                               | Alice   | Alice        | No prompt. This is today's behavior.                                                     |
| Writes with an app credential                                                | Agent   | any          | Consent doesn't apply. Approval policies do.                                             |

## Rollout

1. **Before 1.0: identity and consent.** Add `addressed` to deliveries, add
   `owner`, `contributors`, and `directedBy`, and redefine `auth.current`. Add
   `actAs`, `access`, and `purpose`, consent requests with `consent_declined`,
   owner-targeted requests, and the git extension fields. With today's
   queueing, only ambient turns see new prompts.
2. **Opt-in steering:** `defineAgent({ experimental: { multiplayerSteering: true } })`,
   first in code channels.
3. **Default steering.** Remove the queue path for other principals. Decide
   before 1.0 whether this ships in 1.0 or waits for a major release.

## Alternatives considered

- **Fix it in the agent's instructions.** It would help, but it's a prompt
  against a model, and every agent would have to get it right.
- **Turn off passive listening.** It removes the trigger, not the gap. An
  explicit mention that the model misreads still runs on the sender's access.
- **Write with an app identity.** Nobody's personal access is used, but the
  agent's own authority still follows ambient chatter, and attribution is lost.
  This stays an author choice (`principalType: "app"`), and approval policies
  govern it.
- **Always use the owner's access.** That opens the PR for the right person,
  but it lets anyone's text drive the owner's access.
- **Keep queueing.** It still allows the incident, because Carol's turn wasn't
  steered. It also stalls threads (#6148).
- **Intersect permissions.** Credentials are opaque tokens, so eve can't
  compute an intersection.

## Testing

E2E evals, written as ordinary Alice, Bob, and Carol narratives:

- An ambient message that resumes earlier work raises consent before a write,
  and declining it reaches the model as `consent_declined`.
- A read-only call in an ambient turn runs without a prompt.
- Bob's addressed steer resolves his own token for a user-scoped connection.
- An owner-bound write after Bob steers asks Alice, and Bob can't answer it.
- An approval policy that checks contributors approves the write without a
  prompt.
- An inbound hook can't mark a message as addressed.
- With steering limited to the owner, other principals' messages queue as
  today, and consent still applies.

## Open questions

- **Ambient reads.** Should reads also need consent in ambient turns? They
  can post the subject's private data into a shared thread.
- **Unmentioned follow-ups.** Should the person who addressed the agent stay
  addressed for their follow-ups in the same thread? That's less friction, but
  it reopens the passing-remark case for people who once addressed the agent.
- **Naming.** `auth.owner` and `auth.directedBy`, or turn-level fields under
  `ctx.session.turn`? Is `actAs` clear next to `principalType`?
- **Transferring ownership.** Should Bob be able to take over a turn, given
  that his text alone shouldn't escalate?
- **Control messages.** Should `reset`, `clear`, and cancel from another
  principal need the owner? Session admission (`execution/session/admission.ts`)
  doesn't check the principal; channels may.
- **Consent scope.** Is consent per call, or per turn and connection? Per
  call is safest. A turn with several pushes would prompt repeatedly.
