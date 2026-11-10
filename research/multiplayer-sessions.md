---
issue: "None (maintainer proposal)"
status: proposed
last_updated: "2026-11-10"
---

# Multiplayer sessions

## Problem

Several people share one session when they work in the same Slack thread, code channel, or
GitHub issue. Two things go wrong today.

**Other people's messages wait.** Only a turn's own caller steers it. A message from anyone
else waits for the turn to end and then runs as its own turn (`isSteeringDelivery` in
`execution/session/input-queue.ts`). The agent goes quiet for everyone but one person, and the
model never gets to decide whether a comment changes what it's doing.

**The agent acts as whoever spoke last.** Bob asked for a pull request, the turn ended without
one, and Alice replied "oh this is flaky". Her reply started a turn as Alice, the model picked
up Bob's request from the history, and the pull request opened with Alice's GitHub account.
Alice could as easily have meant "open it", so no rule about her message would have been right.
The model did something neither of them asked for, with credentials that looked related.

The first is eve's to fix. Messages wait because a turn's credentials are its caller's, and
eve has no other way to stop one person's words from spending another person's credentials.
The second is a model error that eve can't rule out. It can give tools a way to state whose
request a call serves, and a person to ask when that isn't the caller.

## Rules

1. **A turn has one caller.** The caller is the sender of the message that started the turn,
   and never changes while the turn runs. Unchanged from today.
2. **Anyone the channel admits steers.** Their message joins the running turn. It changes what
   the model reads, never who the caller is.
3. **eve hands out the caller's credentials without asking only while the caller is the last
   person to have spoken.** After anyone else's message joins the turn, a call that needs the
   caller's token asks the caller first, or is refused where eve can't ask.

Nothing is added to tool, connection, or channel definitions. `ctx.session.auth` gains one
field, and `once()` and `always()` gain one option.

## API

### Turn policy

`turnPolicy` keeps its two values. `"steer"` now joins the running turn whoever its caller is,
on every channel, and `"queue"` still waits for the turn to end.

### The latest sender

```ts
interface SessionAuth {
  readonly initiator: SessionAuthContext | null; // who started the session
  readonly current: SessionAuthContext | null; // the turn's caller
  /**
   * Who last sent a message into the turn or answered one of its approvals.
   * Equal to `current` until another person's message joins the turn.
   */
  readonly sender: SessionAuthContext | null;
}
```

### Approval helpers

`always()` and `once()` take a `when` option. With `when: "principal-mismatch"`, they ask only
while `auth.current`, `auth.sender`, and `auth.initiator` aren't all the same person:

```ts
import { always, once } from "eve/tools/approval";

// Ask on every call while someone other than the caller is involved.
approval: always({ when: "principal-mismatch" }),

// Ask once for each combination of caller, sender, and initiator.
approval: once({ when: "principal-mismatch" }),
```

Both stay plain request policies, so they work on a tool, on a connection, as the `request` of
an approval configuration, and as the agent-wide `approval` in `agent.ts`, where one line
covers every tool. Rule 3 is
the caller-and-sender half of the same check, applied by eve wherever it hands out the caller's
token. The helpers bring it, and the initiator, to tools that use no credentials.

## Semantics

### Steering

Another person's message joins the running turn at the same points a caller's own message does
today. `auth.current`, the turn's memory scope, its hooks, and its dynamic functions stay the
caller's. `auth.sender` changes only between model steps: when the step that reads a message
starts, or the step after an approval is answered. Every call the model makes in one step sees
the same value, and an approval of one call doesn't change what its siblings see.

`sender` is always set. eve fills it wherever it builds `ctx.session.auth`, so code never falls
back to `current`. `SessionAuth` is passed into authored code, never taken from it, so a new
member is a minor change under the stability policy.

### The last to speak

The caller is the last to speak while `auth.sender` is the caller: from the start of their turn
until someone else's message joins it. Sending a message, or answering one of the turn's
approvals, makes them the last to speak again.

### Mismatch approvals

With `when: "principal-mismatch"`, a helper returns `"not-applicable"` when caller, sender, and
initiator are one person, which is every call in a session with one person. Otherwise:

| Mismatch                   | Example                               | `always`                                  | `once`                                  |
| -------------------------- | ------------------------------------- | ----------------------------------------- | --------------------------------------- |
| Sender isn't the caller    | Alice comments during Bob's turn      | Asks Bob once, then again when she speaks | Asks Bob once for Alice, then not again |
| Caller isn't the initiator | Alice's turn in a session Bob started | Asks Alice on every call                  | Asks Alice once                         |

- Only the caller can approve, because the call runs on their identity. Anyone can deny. A
  tool's own `response` policy still applies. Today, without a `response` policy, only the
  requester can answer at all, so letting anyone deny is new for these requests.
- `once` remembers for the tool and for that combination of caller, sender, and initiator,
  until the session ends. Bob's approval after Alice steers covers Alice steering Bob again. It
  doesn't cover Carol. Approving makes Bob the sender, so the approval also covers the same
  combination with Bob as sender: he approved with more people involved. Without that, in a
  session Carol started, Bob would be asked again on the very next call.
- The `always` cell for a sender mismatch assumes the caller started the session. Otherwise
  the caller-isn't-initiator row also holds, and `always` asks on every call.
- Principals are compared by identity, as steering compares them today: unauthenticated and
  anonymous principals are one person, and an anonymous person steering an authenticated
  caller's turn is a mismatch.
- A delivery without `auth` isn't another person. As today, it acts as the turn's identity and
  leaves `auth.sender` unchanged. Rule 3 can tell apart only the people a channel identifies,
  so a channel that admits several people must set `auth`. A server-side `send()` without
  `auth` is the author speaking as the session.

A request policy can't say who may answer today: only `approval.response` can. eve's helpers
already tell the harness what to remember through a channel private to them
(`approval/evaluation.ts`), and they name the required responder the same way. The approval status and policy types don't
change, and `once()` keeps rejecting input-scoped options.

### The default

Rule 3 applies in two places, because approvals are decided before a call runs and a token is
resolved while it runs.

**Connection tools.** eve knows a connection is user-scoped before its tools run. While the
caller isn't the last to speak, eve asks the caller before each call, as
`always({ when: "principal-mismatch" })` does for the caller and sender. eve applies it after
the connection's and the agent's `approval` are evaluated, not as one more policy in their
strictest-wins join (`approval/agent.ts`), where an ask would outrank any clearance. A denial
stays a denial, and any other result becomes an ask unless a mismatch helper cleared the call.
Approving makes the caller the last to speak, so later calls run until another message joins.

**Authored tools.** A tool resolves its provider inside `execute`, where a call can stop only
for a sign-in. While the caller isn't the last to speak, `ctx.getToken()` for a user-scoped
provider fails with `ConnectionAuthorizationFailedError`,
`reason: "caller_confirmation_required"`. The message tells the model who spoke since and that
the caller can confirm by replying. A tool that wants a prompt sets a mismatch helper as its
`approval`.

A mismatch helper on the tool, the connection, or the agent replaces the default for the calls
it clears, including when an author's own policy calls it. The helper's own evaluation signals
the clearance through the private evaluation channel. Any other `"approved"`, such as from
`auto()` or a custom policy, still gets the default: only the caller's approval releases their
token. A call a helper cleared, by asking or from `once`'s memory, gets the caller's token,
even while `auth.sender` is still someone else. A
sibling call in the same step that wasn't cleared is still refused, and the model can retry it
in the next step, once the caller's approval has made them the last to speak. So one line in
`agent.ts` chooses how the whole agent asks:

```ts
export default defineAgent({
  approval: once({ when: "principal-mismatch" }),
});
```

A session with one person never reaches any of this.

### What rule 3 doesn't cover

- A token resolved for someone other than the caller: `ctx.approval.responder.getToken()`
  already requires that person's approval.
- App-scoped connections and tools that use no credentials. The approval helpers are for
  these.
- A turn's first calls. The caller started the turn, so they are the last to speak. This is
  the incident, and the practice below is what narrows it.

### Paused turns

A turn waiting on an approval, sign-in, or question still takes only the answer, and messages
from its caller. Other people's messages wait for the pause to end and then join the turn,
where today they wait for the turn to end.

### Delegation

Handing the caller to another agent uses their identity. A local subagent's session inherits
the parent's `auth.sender` with its caller and initiator, so a subagent called after someone
else spoke can't hand out the caller's token unasked. A `forwardPrincipal` connection and a
remote agent that forwards the principal ask the caller first, like a user-scoped connection
tool. The parent asks before anything is sent, so the forwarded-principal format doesn't
change and the remote agent never needs to know who spoke.

### Stream and traces

`delivery.admitted` already records each message's sender. A confirmation is an approval
request on the stream, a refusal is a failed call, and traces record the latest sender on each tool call beside the turn's
caller.

## Recommended practice: name the actor

A tool that acts as a person can take an `actor` in its own input schema: the person whose
request the call carries out. When the model names someone other than the caller, the tool asks
that person and runs with their token. This uses approval APIs that ship today:

```ts title="agent/tools/gh.ts"
const github = connect("github/my-agent"); // a user-scoped provider
const slackId = (auth: SessionAuthContext | null) => auth?.attributes.user_id;
const onMismatch = once({ when: "principal-mismatch" });

export default defineTool({
  description:
    "Run one gh command. Set actor to the Slack user id of the person whose request it carries out.",
  inputSchema: z.object({ command: z.string(), actor: z.string() }),
  approval: {
    // For the caller, ask only on a mismatch. For anyone else, always ask.
    request: (ctx) =>
      ctx.toolInput?.actor === slackId(ctx.session.auth.current)
        ? onMismatch(ctx)
        : "user-approval",
    response: async ({ request, response, auth }) => {
      if (response.decision === "deny") return { status: "allowed" };
      if (slackId(response.principal) !== request.toolInput?.actor) {
        return {
          status: "rejected",
          reason: "Only the person this command is for can approve it.",
        };
      }
      await auth.getToken(github); // signs the actor in if they haven't connected
      return { status: "allowed" };
    },
  },
  async execute({ command }, ctx) {
    // The approver is the actor. Without an approval, the actor is the caller.
    const { token } = await (ctx.approval?.responder ?? ctx).getToken(github);
    return runGh(command, token);
  },
});
```

The field is the author's, it is in the schema from the first turn, and it never changes, so
the prompt cache is unaffected. eve documents the pattern. The git extension's `gh` tool adopts
it in a follow-up: rule 3 already guards its token.

In the incident, the model would most likely have named Bob. Bob is asked, and the pull request
opens as Bob. If it names Alice, the call runs as Alice.

## Scenarios

| Scenario                                                                 | Result                                                                                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bob's turn is running. Alice adds "it's the retry logic in foo.ts".      | Joins the turn, and the model adjusts. The next `gh` asks Bob once; without a helper it is refused until Bob replies. The pull request opens as Bob. |
| Bob's turn is running. Alice asks "break it down by customer".           | Joins the turn. With `actor`, the query names Alice, asks her, and runs with her access. Without it, Bob is asked.                                   |
| Bob's request fails. Alice replies "oh this is flaky". Tool has `actor`. | Alice's turn. `gh` names Bob, Bob is asked, and the pull request opens as Bob.                                                                       |
| The same, and the tool has no `actor`, or the model names Alice.         | Runs as Alice. She started the turn and spoke last. eve can't tell this from "open it".                                                              |
| An outsider comments on a GitHub issue during a maintainer's turn.       | Joins the turn. The maintainer's tokens ask the maintainer. A team-only tool with `always({ when })` asks them too.                                  |
| One person, any channel.                                                 | Nothing changes.                                                                                                                                     |

## Security model

eve hands out a person's token in two cases:

- they started the turn and nobody else has spoken since they last spoke or answered an
  approval, or
- they approved the call.

Both are decided from who sent which message and who pressed which button, never from what the
model said.

What remains is the first case at the start of a turn. A person who just spoke to the agent can
see it do something they didn't ask for with their credentials. Naming the actor makes that
less likely, because the model has to say whose request a call serves and the answer is checked
against the caller. It doesn't remove it.

Tools that decide from the caller's role without using their credentials are outside the
default. They use the approval helpers, or read `auth.sender` in their own policy.

## Alternatives considered

| Alternative                                          | Why not                                                                                                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An `actor` option that makes eve add the argument    | eve would inject an argument the author didn't write, the schema would change mid-session and break the prompt cache, and it is a top-level option that is hard to reason about. |
| Decide from whether the message mentioned the agent  | A mention is a weak sign of intent. An unmentioned reply can be a real request.                                                                                                  |
| A third turn policy that keeps other people waiting  | Steering is the goal. An agent that needs every message to wait has `"queue"`.                                                                                                   |
| Hand out the caller's token after others speak       | Other people's words would spend the caller's credentials with nobody asked.                                                                                                     |
| Ask before every tool call after someone else speaks | Nothing could be missed, but a web search would ask the caller after every comment.                                                                                              |
| Switch the turn's caller to the latest sender        | Bob's work would finish as Alice, with her memory scope and her account.                                                                                                         |

## Compatibility and validation

- **Steering.** Another person's message now joins the running turn on every channel.
  `turnPolicy: "queue"` is the way to make messages wait. Steering and rule 3 ship in the same
  release: steering alone would let other people's words spend the caller's credentials.
- **Confirmation.** In a turn someone else has joined, a user-scoped connection tool asks the
  caller, and an authored tool's `ctx.getToken()` for a user-scoped provider is refused unless
  a mismatch helper covers the call. Sessions with one person don't change.
- **Role checks.** A tool that decides from `auth.current` alone doesn't see who else is
  steering. The auth and human-in-the-loop docs show the approval helpers for it.
- **Docs.** "A turn runs as one principal" is restated: the caller is fixed, and other people's
  messages can join.
- **Additive API.** `SessionAuth.sender`, the `when` option on `always()` and `once()`, and the
  `caller_confirmation_required` reason.

E2E evals, in `agent-tools-hitl`: Bob's message joins Alice's running turn; her next
user-scoped connection call asks Alice once, refuses Bob's answer, and the calls after it run;
an authored tool's token is refused with `caller_confirmation_required` until Alice replies; a
tool reads Bob as `auth.sender`; `always({ when })` asks Alice after Bob speaks and refuses Bob's
approval; `once({ when })` asks Alice once in a session Bob started; a session with one person
is never asked; a local subagent called after Bob speaks is refused Alice's token; a fixture
tool with an `actor` field asks Bob in Alice's turn and runs with Bob's token. Existing evals
change: in `other-person-message-waits`, Bob's message joins Alice's turn once her approval
settles, and in `authorization-principal-after-other-speaker`, it joins once her sign-in
completes.

## Out of scope

- Letting another person's message steer a turn that is paused on an approval or sign-in.
  Rule 3 pauses turns more often, so this is the first follow-up.
- Covering tools that use no credentials by default.
- Adopting `actor` in the git extension's `gh` tool. It needs an identifier the model sees on
  every channel, has to combine with the tool's existing input-based approval, and resolves
  its token per request, so a refusal can come mid-command.
- Whether plain `once()` should remember for each caller. Today it remembers for the tool, so
  Bob's approval covers Alice's later calls in the same session.
- Whether the default should also ask when the caller isn't the initiator. As drafted it
  compares only the caller and the sender, so the incident runs as Alice unless a helper or the
  actor practice covers the tool.
- A per-session access list. Channels still decide who reaches a session.
