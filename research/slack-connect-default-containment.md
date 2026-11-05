---
issue: "TBD (maintainer-requested research before 1.0; no matching issue found)"
status: in-progress
last_updated: "2026-11-02"
---

# Slack allowFrom

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

One option, `allowFrom`, decides who can reach the agent. It matches Twilio's
required `allowFrom` ("caller/sender numbers allowed to reach inbound hooks"),
so other channels can adopt the same name. It is inbound only. eve uses `auth`
for identity and approval policies for authorization, and `allowFrom` is
neither: an internal user in a Slack Connect channel has a valid identity but
is still refused there.

```ts
import { defaultSlackAllowFrom, slackChannel } from "eve/channels/slack";

// Default: refuse Slack Connect conversations and guests.
export default slackChannel({ credentials });

// Only these users, on top of the default.
export default slackChannel({ credentials, allowFrom: ["U01ALICE", "U02BOB"] });

// A custom policy: serve one Slack Connect partner channel too.
export default slackChannel({
  credentials,
  allowFrom: async (request) =>
    request.channelId === "C0PARTNER" || (await defaultSlackAllowFrom(request)),
});

// Opt out entirely (the pre-1.0 behavior).
export default slackChannel({ credentials, allowFrom: () => true });
```

```ts
type SlackAllowFrom =
  | readonly string[]
  | ((request: SlackInboundRequest) => boolean | Promise<boolean>);

interface SlackInboundRequest {
  readonly kind: "message" | "edit" | "event" | "answer" | "interaction" | "command" | "shortcut";
  readonly channelId: string | undefined;
  /** The workspace that installed the app. */
  readonly installationTeamId: string | undefined;
  /** Matches `submission.user`, `command.user`, and `shortcut.user`. */
  readonly user: { readonly id: string; readonly teamId?: string } | undefined;
  /** Memoized; `true` when the conversation cannot be classified, `false` without one. */
  isExternalConversation(): Promise<boolean>;
  /** Memoized `users.info` guest check; `true` when the user cannot be classified, `false` without a user. */
  isGuest(): Promise<boolean>;
  /** The signed Slack payload. */
  readonly raw: Readonly<Record<string, unknown>>;
  readonly slack: SlackWorkspaceHandle;
}
```

- A list admits only those user IDs and keeps the default checks. A function
  decides alone; call `defaultSlackAllowFrom` from it to keep the default.
  Twilio's `allowFrom` takes a list or a no-argument resolver today and could
  gain the predicate form later.
- `defaultSlackAllowFrom(request)` returns `false` when
  `isExternalConversation()` or `isGuest()` resolves `true`. It checks the
  conversation first, so a Slack Connect request costs no `users.info` call.
- Message hooks still decide routing and the `{ auth }` result, but they no
  longer need to repeat access checks.
- Message contexts also gain `ctx.isExternalConversation()` beside
  `isDMOrPrivateChannel()`.
- Reading Slack Connect conversations through the Slack API is unaffected.

## Semantics

### Where `allowFrom` runs

The channel checks `allowFrom` before it picks a hook, so authoring
`onMessage`, `onEvent`, or any other hook cannot skip it.

| `kind`        | Surface                                                           | When refused or throwing                         |
| ------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| `message`     | `app_mention`, DMs, `message.*`, code channel messages            | Dropped: no turn, no `received` reaction         |
| `edit`        | `message_changed` for a message addressed to the agent            | Dropped                                          |
| `answer`      | `block_actions` and `view_submission` for approvals and questions | Rejected; the request and its controls stay open |
| `interaction` | `onInteraction` actions                                           | Dropped                                          |
| `command`     | Slash commands                                                    | Dropped; Slack still gets its ack                |
| `shortcut`    | Global and message shortcuts                                      | Dropped                                          |
| `event`       | `onEvent` callbacks and code channel stops                        | Dropped                                          |

A throw counts as a refusal. Refusals are logged at `info` with the channel ID
and `kind` only. A sign-in prompt's Cancel button and the "Type your answer"
modal opener are not checked; the modal's submission is.

Sends that start a session (`receive`, `ctx.send`, `ctx.to()`) are not
checked. Tools that post with `callSlackApi` can run the same classification
themselves (see the follow-up that exports it).

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
   an API call. Messages therefore need no extra scope or request. Trade-off:
   the envelope flag doesn't report a pending share, so a mention in a channel
   whose share is still pending is allowed. Only a `true` flag is cached, so a
   later answer or command in that channel still gets the lookup that sees the
   pending share.
2. Otherwise use `conversations.info`, cached per installation and channel for
   five minutes (failed lookups for one minute).
3. If the lookup fails (missing scope, API error, or a missing `channel` in the
   response), the answer is `true`. The check **fails closed**.

### Guests

`isGuest()` is `true` when `users.info` reports `is_restricted` (a
multi-channel guest) or `is_ultra_restricted` (a single-channel guest). It
caches verdicts per installation and user for five minutes (failed lookups for
one minute) and fails closed. Events without a user skip it.

### Scopes

The envelope flag needs no scope. `conversations.info` needs `channels:read`,
`groups:read`, `im:read`, and `mpim:read`, and `users.info` needs
`users:read`. The generated manifest now always includes all five; it used to
add the read scopes only with `codeChannels` and `users:read` only with
`messageContext.users`.

Vercel Connect's default Slack bot scopes include `channels:read`, `im:read`,
and `users:read`, but not `groups:read` or `mpim:read`. On a default connector,
interactions, slash commands, and shortcuts in private channels and group DMs fail
the conversation lookup and are refused. Vercel Connect's defaults should add
the two scopes; until then, those apps need them added to the connector.

Self-managed apps that upgrade usually lack `users:read`, so the guest check
refuses every person until the app is reinstalled. That failure must be loud:
a lookup that fails with `missing_scope` logs an error naming the scope
(Slack's `needed` field), refused inbound requests get an ephemeral notice to
the person who asked. A
Slack object without the flags the check reads counts as unclassified, not
as internal or a member.

## Migration

This is a breaking change to default behavior and ships before 1.0 GA. The
changeset and the Slack docs say that agents serving Slack Connect users set
`allowFrom`, either `() => true` or a narrower policy.

Docs changes:

- `docs/channels/slack/index.mdx` "Restrict access": lead with the default, and
  replace the three-hook allowlist with one `allowFrom`.
- `docs/channels/slack/reference.mdx` "Restrict who can invoke the agent":
  document `SlackInboundRequest`, `defaultSlackAllowFrom`, and composing them.
- `apps/templates/eve-company-brain-template/README.md`: drop the
  "does not check Slack Connect" caveat.

## Other channels (follow-up)

An audit of the other built-in channels found the same gap. Webhook
verification proves the provider sent the event, not that the sender should
reach the agent. The same shape can carry over: an `allowFrom` option with an
exported per-channel default.

- **GitHub** (highest priority): any `@bot` comment starts a turn, with no
  `author_association` check. On a public repo, any GitHub user can drive the
  agent, and replies are world-readable. The default would allow `OWNER`,
  `MEMBER`, and `COLLABORATOR`, matching the coding-agent template.
- **Teams**: no tenant check, so guests and cross-tenant shared channels get
  in. The default would allow the installing tenant.
- **Discord, Telegram, Linq, Photon**: no org boundary to default to. These need
  a decision on whether to require an explicit `allowFrom`, like Twilio.
- **Chat SDK**: the docs examples send without auth, and when the requester is
  anonymous, anyone can answer an approval. Fix the examples.

## Open questions

- Whether a channel that can post somewhere new needs a separate outbound
  check, or whether exported classification helpers are enough.
