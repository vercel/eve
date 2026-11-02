---
issue: "TBD (follow-up to the Slack admit research in vercel/eve#5816; no matching issue found)"
status: in-progress
last_updated: "2026-11-02"
---

# Teams access boundary

> **AI status:** Written entirely by AI; human review pending.

## Problem

The Teams channel admits anyone whose activity carries a valid Bot Connector
token. That proves Teams sent it, not that the sender belongs to the
organization. By default:

- a person from another tenant in a shared channel can mention the agent and
  drive it with the installer's connections and data;
- an internal user's mention in a shared channel gets a reply that the other
  tenant's members can read;
- guests and anonymous meeting participants can use the agent and click its
  approval cards like any member.

[#5816](https://github.com/vercel/eve/pull/5816) closes the same gap for Slack
Connect with an `admit` hook. This plan carries the shape over to Teams.

## Authoring API

```ts
import { defaultTeamsAdmit, teamsChannel } from "eve/channels/teams";

// Default: refuse other tenants, shared channels, guests, and anonymous users.
export default teamsChannel({ credentials });

// Narrow it with an allowlist of Microsoft Entra object ids.
export default teamsChannel({
  credentials,
  async admit(request) {
    if (!(await defaultTeamsAdmit(request))) return false;
    return request.kind === "send" || allowedUsers.has(request.actor?.aadObjectId ?? "");
  },
});

// Opt out (the pre-1.0 behavior).
export default teamsChannel({ credentials, admit: () => true });
```

```ts
interface TeamsAdmitRequest {
  readonly kind: "message" | "answer" | "invoke" | "send";
  readonly conversationId: string;
  readonly conversationType: string | undefined;
  /** The conversation's tenant. */
  readonly tenantId: string | undefined;
  readonly actor: { readonly userId: string; readonly aadObjectId?: string } | undefined;
  /** Memoized; `true` when the conversation or sender can't be classified. */
  isExternalConversation(): Promise<boolean>;
  /** Memoized; `true` when the sender can't be looked up, `false` without an actor. */
  isGuest(): Promise<boolean>;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly teams: TeamsHandle;
}
```

The fields follow Teams' own vocabulary (conversation, tenant, Entra object
id) rather than Slack's, but the hook, the two classifiers, the exported
default, and the fail-closed semantics match Slack's.

## Semantics

| `kind`    | Surface                                                  | Refused                          |
| --------- | -------------------------------------------------------- | -------------------------------- |
| `message` | Messages, before `onMessage`                             | Dropped                          |
| `answer`  | Card submissions (invoke or message) and sign-in presses | Rejected; the request stays open |
| `invoke`  | `onInvoke` activities                                    | `200 OK`; the hook doesn't run   |
| `send`    | `receive`, via `to()` and `ctx.to()`                     | Throws before anything is posted |

Teams has no cheap equivalent of Slack's `is_ext_shared_channel`.
`isExternalConversation()` combines what the activity carries with one
member lookup:

1. No conversation tenant, or `channelData.tenant.id` and
   `conversation.tenantId` disagree.
2. A configured `credentials.tenantId` that differs. Multi-tenant bots,
   including Vercel Connect bots, have none and admit their installing tenant.
3. `channelData.channel.type === "shared"`. The field is optional, so a shared
   channel that doesn't report its type relies on check 4.
4. The sender's tenant from `from.tenantId` or the member lookup differs from
   the conversation's.

`isGuest()` reads `userRole` from the same lookup: `guest` and `anonymous`
are refused. The lookup is
`GET {serviceUrl}/v3/conversations/{teamId ?? conversationId}/members/{from.id}`,
cached per tenant, roster, and user for five minutes (one minute after a
failure). Any failure answers `true` for both checks.

A send has no sender and no channel type, so it checks only the tenant and
requires `target.tenantId`.

## Limits

- Checks cover the conversation's tenant, its reported channel type, and the
  sender. An internal sender in an unmarked shared channel whose other members
  never message the agent still gets an answer. Closing that needs a Graph
  roster audit with extra permissions, which is out of scope.
- `userRole` values come from Microsoft's SDK types and docs, not an exhaustive
  enum. A role other than `guest` or `anonymous` is treated as a member.
