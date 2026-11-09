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
that uses it. Otherwise eve asks that person first. There is no read
exception, because reads are where a person's data reaches a shared thread. A
tool author can relax the rule only by writing an explicit policy. The default
is the safe path.

Directing the agent is necessary but not sufficient. Destructive actions
still need approval policies, because a model can misread even an explicit
request.

## Why before 1.0

`ctx.session.auth.current` is a stable API, and the docs promise that "the
caller stays the same for the whole turn" and that another person's message
"waits for the turn to end." The consent rule adds prompts to turns that run
silently today. All three change stable behavior, so everything in this plan
ships in 1.0, including steering by any principal as the default. After 1.0,
the same changes would need 2.0.

## Addressed messages

Every human message gets a channel-neutral `addressed` flag: `true` when the
sender is talking to the agent, `false` when the agent just overhears it.

| Channel                     | Addressed                                                                                                                                   | Ambient                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Slack                       | A mention, a DM, a code-channel message, or a reply from the person the agent's latest message answered, when nobody else has written since | Other replies in a followed thread, and watched-channel messages |
| `eveChannel`, `source.send` | Default `true`: the caller sent it on purpose                                                                                               | When the sender passes `addressed: false`                        |
| Other platform channels     | A mention or DM, in each channel's terms                                                                                                    | Everything else they deliver                                     |

The Slack reply rule follows conversational turn-taking. Alice can answer the
agent without mentioning it. Once someone else writes in between, she mentions
it again, as people already do in busy threads. Only the channel knows the
thread's order, so each channel implements this rule itself. Code channels
count every message as addressed, because people join them to work with the
agent.

Slack already knows the difference (`isBotMentioned()`, the
`app_mention`/`direct_message`/`channel_message` kinds) and puts `mentioned:`
into the model's context. This plan makes it a delivery fact that credential
resolution can read. An inbound hook can lower `addressed` to `false` but can
never raise it. Raising it would let a hook manufacture consent.

## Identities in a turn

All identities live on `ctx.session.auth`:

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
The `SessionAuth` type comment already describes `current` as "the caller of
the most recent request." Only the auth guide's per-turn promise changes.

`owner` never changes within a turn, so it stays a trustworthy fact for
attribution and for requests that only the owner may answer. Nobody can take
over a turn. A person who wants work done under their own name directs it, and
the tool acts as `current` (see [Choosing the identity per call](#choosing-the-identity-per-call)).

Each model call records its speaker and `directedBy` in durable state, so
replay binds the same credentials. A tool call keeps the values of the step
that emitted it, even if a steering message arrives while it runs.

## Consent rule

When a user-scoped credential resolves, eve compares its subject (the person
whose token it is) with `directedBy`:

```text
subject === directedBy                → resolve, as today
approval policy returned "approved"  → resolve
turn grant from the subject exists    → resolve
otherwise                             → consent request to the subject
principalType: "app"                  → not a person's access; approval policies apply
```

A consent request reuses the held sign-in (`research/held-sign-in-and-approval.md`):
the turn holds, and only the subject can answer. The card says what the agent
wants to do and for whom. For example: "The agent wants to push a branch and
open a pull request in `acme/web` as you, continuing a request from Alice."

The card offers three answers:

- **Allow once** resolves this call only.
- **Allow for this turn** creates a turn grant for one subject and one
  connection. The grant ends with the turn. It is revoked when a new
  contributor joins, because Alice agreeing while Bob directs isn't agreement
  for Dave. A grant never covers an approval that a policy requires on its
  own.
- **Decline** fails the call with an error the model can act on:

```text
ConnectionAuthorizationFailedError reason: "consent_declined"
"Carol declined to let the agent act as them on GitHub. Ask the person who
requested this to confirm it in the thread."
```

Allowing doesn't make the subject `directedBy`. Consent covers what the card
showed, and nothing more.

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

### Credential binding

```ts
// The default, written out
auth: connect({ connector: "acme/snowflake", principalType: "user", actAs: "current" });

// One call, with the sentence shown on a consent card
await ctx.getToken(connect("acme/github"), { actAs: "owner", purpose: "Open the pull request" });
```

- `actAs: "current" | "owner"` resolves `auth.current` or `auth.owner`.
  `"current"` is the default and today's behavior. `actAs` is a type error on
  `principalType: "app"` connections.
- `purpose` is the sentence on the consent card, in the same form as the git
  extension's `signInReason`.

### Choosing the identity per call

A tool may let the model choose `actAs` for each call, with its configured
value as the default. This is safe because every choice still passes the
consent rule. A wrong choice costs a prompt to the right person, never someone
else's access. When Bob says "open it under me," the model picks `"current"`.
Bob directed the step, so the call runs as Bob.

### Approval policies can pre-approve

The call's approval policy (`ApprovalPolicy`, which already extends
`SessionContext`) sees `owner`, `contributors`, and `directedBy`. Returning
`"approved"` for a call that needs consent skips the prompt. This is the only
escape hatch, and it has to be written as code. An author who wants ambient
reads without prompts writes it explicitly:

```ts
approval: ({ toolAnnotations }) => (toolAnnotations?.readOnlyHint ? "approved" : undefined),
```

To check other people, the policy context gets a public form of the internal
`getResponderToken` (`runtime/authorization-context.ts`), which reads a stored
token without starting a sign-in.

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

The `gh` tool accepts an optional `actAs` input that defaults to this config,
so the model can choose per call. `authorize` gains `owner`, `contributors`,
and `directedBy`. `attribution` may return several co-authors, so a PR that
Bob shaped credits him. The extension doesn't pre-approve any command. An
author who wants ambient `gh pr view` without prompts writes that policy.

## Steering

Any principal's message steers the running turn. The consent rule decides
what each step may do with whose access.

| Input during a turn                               | Result                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Message from the owner                            | Steers, as today.                                                                                                      |
| Message from another principal                    | Steers. They become the speaker from the next step on. A new contributor joins `contributors` and revokes turn grants. |
| Another principal's message during a held sign-in | Steers and withdraws the held sign-in as `declined` (#6148). Pending approvals stay pending.                           |
| Answer to an open request                         | Settles it as its responder without changing the speaker, as today.                                                    |
| Cancel, `reset`, or `clear`                       | Accepted from anyone admitted to the session. Withdraws the turn's pending consent requests.                           |
| Delegated caller mismatch (`callerCallId`)        | Queues, as today. This is routing, not identity.                                                                       |

Controls use nobody's access, so the consent rule doesn't cover them. eve
keeps no per-session access list, and Slack requires agents to honor a
code-channel stop. Each control records its sender (`ControlOrigin.auth`), so
a channel or hook can refuse a `reset` or `clear` as app policy.

Tasks and subagents bind the speaker and `directedBy` of the step that starts
them. Input a later step sends them carries that step's values. Each steering
message from another principal is attributed in the model's input, with
sender and `addressed`.

## Scenarios

| Scenario                                                                     | Subject | `directedBy` | Result                                                                                   |
| ---------------------------------------------------------------------------- | ------- | ------------ | ---------------------------------------------------------------------------------------- |
| Incident: Carol's ambient "flaky :(" leads to a push and a PR                | Carol   | `null`       | Carol is asked. She declines, and the model asks Alice to confirm in the thread.         |
| Someone remarks in passing, and an earlier request would run on their access | Them    | `null`       | They are asked before their access is used.                                              |
| Carol's ambient question needs a read of her Notion                          | Carol   | `null`       | Carol is asked, unless the author's policy pre-approves reads.                           |
| Alice replies to the agent's answer without mentioning it                    | Alice   | Alice        | No prompt.                                                                               |
| Bob steers and asks for a Snowflake table he can't access                    | Bob     | Bob          | The query runs as Bob, and Snowflake denies it.                                          |
| Alice asks for a feature, Bob clarifies, PR with `actAs: "owner"`            | Alice   | Bob          | Alice is asked, unless the policy approves because every contributor can write the repo. |
| Bob says "open it under me"                                                  | Bob     | Bob          | The model picks `actAs: "current"`, and the PR opens as Bob.                             |
| Alice allows a push for this turn, then Dave joins                           | Alice   | Dave         | The grant is revoked, and Alice is asked again.                                          |
| Writes with an app credential                                                | Agent   | any          | Consent doesn't apply. Approval policies do.                                             |

## Delivery

Everything ships in 1.0, in this order:

1. Identity and consent: `addressed` on deliveries; `owner`, `contributors`,
   and `directedBy`; the redefined `auth.current`; `actAs` and `purpose`;
   consent requests with turn grants and `consent_declined`; owner-targeted
   requests; and the git extension fields.
2. Steering by any principal as the default, which removes the queue path for
   other principals.

The first part is safe on its own. The second depends on it.

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
- **Exempt reads from consent.** Ambient reads would carry a person's private
  data into a shared thread they never asked about.
- **Treat anyone who once addressed the agent as addressed.** That reopens the
  passing-remark case for every earlier participant.
- **Explicit ownership handoff.** It adds a request kind and a changing
  `owner` to solve what per-call `actAs` behind the consent rule already
  solves.
- **Owner-only controls.** It would add eve's first per-session access list
  and conflict with Slack's required code-channel stop.
- **Per-turn consent by default.** One tap would cover calls the card never
  showed.
- **Experimental opt-in, or a pinned default that flips in 1.x.** Both keep a
  queue mode with no security reason for it.

## Testing

E2E evals, written as ordinary Alice, Bob, Carol, and Dave narratives:

- An ambient message that resumes earlier work asks for consent before a
  write, and declining reaches the model as `consent_declined`.
- An ambient read asks for consent, and a policy that pre-approves
  `readOnlyHint` tools runs it without a prompt.
- Alice's unmentioned reply right after the agent answers her runs without a
  prompt. The same reply after Bob writes in between asks her.
- Bob's addressed steer resolves his own token for a user-scoped connection.
- An owner-bound write after Bob steers asks Alice, and Bob can't answer it.
- "Allow for this turn" covers later calls on that connection, and Dave
  joining revokes it.
- An approval policy that checks contributors approves the write without a
  prompt.
- An inbound hook can't mark a message as addressed.
- Cancelling a turn withdraws its pending consent requests.

## Decisions

Resolved during review:

1. Reads need consent. Authors opt out per tool with an approval policy, and
   there is no `access` option.
2. Unmentioned Slack replies are addressed by turn-taking, and code channels
   are always addressed.
3. Identities live on `ctx.session.auth` as `owner`, `contributors`, and
   `directedBy`, and `actAs` takes `"current" | "owner"`.
4. Ownership never transfers. Tools may let the model choose `actAs` per call.
5. Anyone admitted to the session may send controls. Refusing `reset` or
   `clear` is app policy.
6. Consent is "Allow once" or "Allow for this turn". Grants cover one subject
   and one connection, and a new contributor revokes them.
7. Steering by any principal is the default in 1.0.
