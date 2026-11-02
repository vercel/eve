---
issue: "TBD (maintainer-requested research before 1.0; no matching issue found)"
status: in-progress
last_updated: "2026-11-02"
---

# Slack access boundary

> **AI status:** Written entirely by AI; human review pending.

## Problem

A Slack app installed in one workspace also receives events from Slack Connect
conversations shared with other organizations. eve's built-in mention, DM,
edit, and answer handlers admit every sender. Replies land in the conversation
the turn came from, so by default:

- an external user can @mention or DM the agent and drive it with the
  installer's connections and data;
- an internal user who mentions the agent inside a Connect channel gets a
  reply that external members can read;
- an external member can click an approval card that was posted in a shared
  channel;
- a guest account, which is in the workspace but outside the organization, can
  drive the agent like any member.

Authors treat the workspace as an implicit trust boundary, and Slack Connect
breaks it without any visible signal.

Today the docs ask authors to restrict access themselves. They show the same
check in `onAppMention`, `onDirectMessage`, and `onAnswers`, and authoring
`onMessage` turns off the default edit handling. In practice authors skip it,
and a correct fail-closed check is subtle enough that every author would
otherwise have to rediscover it. The company-brain template README says
outright that it does not check Slack Connect.

eve is at `1.0.0-rc.1`. Changing this default is cheap now and needs a major
release after GA.

## Authoring API

One hook, `admit`, runs before every Slack surface. eve already uses `auth` for
identity and approval policies for authorization, so admission gets its own
verb. Its default is an
exported function, the same pattern as `defaultSlackAuth` and the built-in
message defaults:

```ts
import { defaultSlackAdmit, slackChannel } from "eve/channels/slack";

// Default: refuse Slack Connect conversations.
export default slackChannel({ credentials });

// Narrow it: add a user allowlist on top of the default.
const allowedUsers = new Set(["U01234567"]);
export default slackChannel({
  credentials,
  async admit(request) {
    if (!(await defaultSlackAdmit(request))) return false;
    return request.kind === "send" || allowedUsers.has(request.actor?.userId ?? "");
  },
});

// Widen it: serve Slack Connect partners in one channel.
export default slackChannel({
  credentials,
  admit: async (request) => request.channelId === "C0PARTNER" || (await defaultSlackAdmit(request)),
});

// Opt out entirely (the pre-1.0 behavior).
export default slackChannel({ credentials, admit: () => true });
```

```ts
interface SlackAdmitRequest {
  /** Which surface is asking. `send` starts a session in a conversation and has no actor. */
  readonly kind:
    | "message"
    | "edit"
    | "event"
    | "answer"
    | "interaction"
    | "command"
    | "shortcut"
    | "send";
  readonly channelId: string | undefined;
  /** The workspace that installed the app. */
  readonly installationTeamId: string | undefined;
  readonly actor:
    | {
        readonly userId: string;
        /** The user's workspace, when Slack reports it. */
        readonly teamId?: string;
      }
    | undefined;
  /** Memoized; `true` when the conversation cannot be classified, `false` without one. */
  isExternalConversation(): Promise<boolean>;
  /** Memoized `users.info` guest check; `true` when the user cannot be classified, `false` without an actor. */
  isGuest(): Promise<boolean>;
  /** Signed Slack payload (or the proactive target for `send`), for anything else. */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Bot-token Slack Web API client, as on other Slack contexts. */
  readonly slack: SlackWorkspaceHandle;
}

type SlackAdmit = (request: SlackAdmitRequest) => boolean | Promise<boolean>;
```

- `defaultSlackAdmit(request)` returns `false` when
  `isExternalConversation()` or `isGuest()` resolves `true`; otherwise it
  returns `true`. It checks the conversation first, so a Slack Connect
  request costs no `users.info` call.
- `admit` is the boundary. Message hooks still decide routing and the
  `{ auth }` result, but they no longer need to repeat access checks. An
  allowlist moves from three hooks into one function.
- Message contexts also gain `ctx.isExternalConversation()` beside
  `isDMOrPrivateChannel()`, backed by the same memoized classifier as the
  request.
- Read tools are unaffected. An agent can still read Connect conversations
  through Slack API calls an author makes.

## Semantics

### Where `admit` runs

The channel calls `admit` before it picks a hook, so authoring
`onMessage`, `onEvent`, or any other hook cannot skip it.

| `kind`        | Surface                                                              | When `admit` returns `false` or throws                              |
| ------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `message`     | `app_mention`, DMs, `message.*`, code channel messages               | Dropped: no turn, no `received` reaction                            |
| `edit`        | `message_changed` for a message addressed to the agent               | Dropped                                                             |
| `answer`      | `block_actions` and `view_submission` for approvals and questions    | Rejected; the request and its controls stay open                    |
| `interaction` | `onInteraction` actions                                              | Dropped                                                             |
| `command`     | Slash commands                                                       | Dropped; Slack still gets its ack                                   |
| `shortcut`    | Global and message shortcuts                                         | Dropped                                                             |
| `event`       | `onEvent` callbacks                                                  | Dropped                                                             |
| `send`        | `receive`, `onEvent`'s `ctx.send`, and `ctx.to()` starting a session | Throws before anything is posted, with an error the model can relay |

A throw counts as `false`. Dropped inbound events are logged at `info` with the
channel ID and `kind` only.

`send` closes the prompt-injection path. Without it, a model can still move
data into a Connect channel through a proactive target, even when inbound
events are contained. Replies to an admitted turn, hook-bound session
operations on the admitted thread, and code channels opened from an admitted
message are not checked again. A sign-in prompt's Cancel button and the
"Type your answer" modal opener are not checked; the modal's submission is.

### External conversations

`isExternalConversation()` is `true` when Slack reports any of these:

- `is_ext_shared` (a live Slack Connect share)
- `is_pending_ext_shared` (a pending share; a reply posted now becomes visible
  once the share is accepted)
- `is_shared && !is_org_shared` (shared across workspaces outside one
  Enterprise Grid org; Grid-internal shared channels count as internal)

Classification works on the conversation, not the author. An author check
misses an internal user posting in a Connect channel. It also rejects users
from sibling workspaces in the same Grid org.

Evidence order, cheapest first:

1. Events API envelopes carry `is_ext_shared_channel`, and eve uses it without
   an API call. Messages therefore need no extra scope or request. The verdict
   is also cached for later interactions in the same process. Trade-off: the
   envelope flag doesn't report a pending share, so a mention in a channel
   whose share is still pending is admitted.
2. Otherwise use `conversations.info`, cached per installation and channel for
   five minutes (failed lookups for one minute).
3. If the lookup fails (missing scope, API error, or a missing `channel` in the
   response), the answer is `true`. The check **fails closed**.

### Guests

`isGuest()` is `true` when `users.info` reports `is_restricted` (a
multi-channel guest) or `is_ultra_restricted` (a single-channel guest). It
caches verdicts per installation and user for five minutes (failed lookups for
one minute) and fails closed. Requests without an actor, such as sends and
events without a user, skip it.

### Scopes

The envelope flag needs no scope. `conversations.info` needs `channels:read`,
`groups:read`, `im:read`, and `mpim:read`, and `users.info` needs
`users:read`. The generated manifest now always includes all five; it used to
add the read scopes only with `codeChannels` and `users:read` only with
`messageContext.users`.

Vercel Connect's default Slack bot scopes include `channels:read`, `im:read`,
and `users:read`, but not `groups:read` or `mpim:read`. On a default connector,
interactions, slash commands, and sends in private channels and group DMs fail
the conversation lookup and are refused. Vercel Connect's defaults should add
the two scopes; until then, those apps need them added to the connector.

## Migration

This is a breaking change to default behavior and ships before 1.0 GA. The
changeset and the Slack docs say that agents serving Slack Connect users set
`admit`, either `() => true` or a narrower policy.

Docs changes:

- `docs/channels/slack/index.mdx` "Restrict access": lead with the default, and
  replace the three-hook allowlist with one `admit`.
- `docs/channels/slack/reference.mdx` "Restrict who can invoke the agent":
  document `SlackAdmitRequest`, `defaultSlackAdmit`, and composing them.
- `apps/templates/eve-company-brain-template/README.md`: drop the
  "does not check Slack Connect" caveat.

## Other channels (follow-up)

An audit of the other built-in channels found the same gap. Webhook
verification proves the provider sent the event, not that the sender should
reach the agent. The same shape can carry over: an `admit` hook with an
exported per-channel default.

- **GitHub** (highest priority): any `@bot` comment starts a turn, with no
  `author_association` check. On a public repo, any GitHub user can drive the
  agent, and replies are world-readable. The default would admit `OWNER`,
  `MEMBER`, and `COLLABORATOR`, matching the coding-agent template.
- **Teams**: no tenant check, so guests and cross-tenant shared channels get
  in. The default would admit the installing tenant.
- **Discord, Telegram, Linq, Photon**: no org boundary to default to. These need
  a decision on whether to require an explicit policy, like Twilio's required
  `allowFrom`.
- **Chat SDK**: the docs examples send without auth, and when the requester is
  anonymous, anyone can answer an approval. Fix the examples.

## Open questions

- Whether `send` should get a narrower request type instead of an optional
  `actor`.
