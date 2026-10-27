---
issue: TBD
status: in-progress
last_updated: "2026-10-27"
---

# Board extension (`@vercel/board`)

> **AI status:** Written entirely by AI; human review pending.

`@vercel/board` is a message board that a Vercel project mounts in one route: a durable log of
channels, threads, labels, and reactions written by OIDC-verified authors, with two-way sync to
Slack, GitHub, Linear, and WhatsApp, and **watchers** that run on every event matching a
`vb tail` expression.

`eve/extensions/board` makes an eve agent a participant on a board another project hosts. It
contributes a channel, six board tools, and a collaboration skill. The board wakes the agent when
a post matches, each board thread is an eve session, and the agent's replies go back to the
thread, and through the board to whatever platform thread it syncs. User docs:
[`docs/channels/board.mdx`](../docs/channels/board.mdx).

## Sources reviewed

- The `@vercel/board@0.19.0` package: its bundled `docs/` and type declarations, the
  authoritative API for the handle, HTTP protocol, identity, access, and watchers.
- Its "Agent Factory" guide: a pull-only client with scoped read and post tools, and no
  wake-ups.

The board's examples run the board and the agent in the same project: a watcher's `run`
starts a sandboxed coding agent, which talks back through the `vb` CLI. Durability then comes
from watcher retries plus files in the sandbox, such as turn locks, inbox files, and session
IDs. eve already provides that durability, so the integration replaces this plumbing instead of
copying it.

## Decision: eve is a remote registrant, not a board host

The board protocol lets another project run watchers: it registers its tails with the board,
the board sends an empty `POST <base>/wake`, and the registrant pulls its matches with its own
credentials, runs them, and acks them. eve implements that role:

- The board stays the one shared surface and owns platform sync.
- Board ordering (one match at a time per thread, threads in parallel) matches eve's
  per-session delivery, and activity during a turn steers it. That replaces inbox files and a
  separate steering mechanism.
- eve speaks the HTTP protocol with an eve-owned client. `@vercel/board` is a `devDependency`
  for tests only.

```text
team board (other project)                         eve deployment
  POST /watchers ◀───────────────────────────────── cold start (bootstrap) · wake (reconcile)
  event matches tail ── POST <prefix>/eve/v1/board/wake ──▶ (empty, unauthenticated)
                     ◀── GET /watchers/matches ──── pull: OIDC aud = board URL, profile = watcher
                                                    onMessage → from(thread:<key>).send(…, idempotencyKey = match id)
                     ◀── POST /watchers/matches/:id/ack ── once send() is accepted, not when the turn ends
  thread             ◀── reactions · typing · replies ── channel delivery
  any channel        ◀── read · post · reply · react · label ── model tools
```

## Authoring API

```ts title="agent/extensions/board.ts"
import board from "eve/extensions/board";

export default board({ tail: "dev --mentions @support", profile: "support" });
```

- `eve/extensions/board`: config `url` (default `BOARD_URL`), `tail`, `when`, `profile`
  (default `"eve"`), and `previews`. Contributes `board__threads`, the tools `board__channels`,
  `board__read`, `board__post`, `board__reply`, `board__react`, and `board__label`, and the
  `board__collaborate` skill. Without `tail`, it's tools and skill only.
- `eve/channels/board`: `boardChannel(config)` for the channel alone, with `onMessage`,
  `events`, `api`, `credentials`, `turnPolicy`, and `uploadPolicy`, plus `defaultBoardAuth`.
- `eve/extensions/board/tools`: the six tools, bound to the mount's config, or to `BOARD_URL`
  and the `"eve"` profile without a mount.

The profile defaults to `"eve"`, not the agent's name, because event handlers and tools don't
know the agent's name, and the profile must match between registration and writes: it is the
watcher's name, which is what keeps the agent's own posts from waking it.

## Semantics

- **Session address.** The board's thread key (`message.thread`), not the root message ID.
  Message IDs are positions in one board's log, so they repeat across boards and after a store
  reset, and would reach another thread's session. The root ID is kept in channel state for
  replies.
- **Dispatch.** `message.posted` events only, as the board-verified author
  (`principalId = by.actor`). Edits, reactions, and labels are acked without dispatch.
  Attachments are file parts the channel's `fetchFile` downloads from the board.
- **At least once.** eve acks after `send()` is accepted, with `board:<match id>` as the
  idempotency key, and acks with `error` when it fails, so the board retries up to five times.
- **Delivery.** `eyes` and typing on `turn.started`, replies split at 10,000 characters, a
  failure note with an error ID, text-only questions answered by the requester's next reply, and
  no sign-in links in shared threads.

## Credentials

Boards accept OIDC tokens only. eve resolves `credentials.token`, then `BOARD_TOKEN`, then the
deployment's Vercel OIDC token exchanged for the board's audience through the vendored
`@vercel/oidc` (bumped from 3.8.0 to 3.8.10, which adds `audience`). In `eve dev`, the same call
refreshes the linked project's development token. On Vercel, the token also goes in
`x-vercel-trusted-oidc-idp-token` for Trusted Sources.

## Registration

Channels and extensions have no build-time hook, and eve runs no authored code at startup, so
registration happens at runtime through an internal channel start hook
(`setChannelStartHook`), which `dispatchChannelRequest` runs once per loaded channel definition
on the first request, whichever route it is.

- **Cold start bootstraps only.** Old deployments keep cold-starting while their runs finish
  (a run stays on the deployment that started it), so a production cold start registers only
  when the project has no registration. Previews share one registration, so the latest preview
  to start takes it.
- **A wake-up on the wake host reconciles.** A wake-up carries no credential, so only one that
  arrives on production's domain (`VERCEL_PROJECT_PRODUCTION_URL`) or a preview's branch URL may
  replace a registration whose watch map or wake target differs: those hosts always reach the
  current deployment, and an older deployment is reachable only on its own URL. A rollback or
  new tail lands on the next wake-up.
- **A manual ping covers the gaps:** the first deploy when nothing cold-starts eve, and a tail
  the old tail never matches. Calling the wake route on the production URL forces the check.
  In a standalone single-agent app, `GET /` is the framework's home channel, so Vercel's
  deployment screenshot usually bootstraps it.
- **Wake target.** `path` (with `branch` on previews) on a board whose discovery says
  `wake_by_path`; otherwise the production or branch URL. Previews register only with
  `previews: true` and share one registration.
- **Locally,** eve registers `url: null` and runs a per-process poller that calls its own wake
  route with a poll header; the route holds a 25-second pull open on the board. A reloaded dev
  runtime replaces the poller.

## Stability

`@vercel/board` is 0.x and ships daily (0.15.0 to 0.19.0 between October 26 and 27, 2026), and
its maintainers don't promise compatibility. This stays in a draft PR tracking the latest
release. The channel joins the shared channel conformance suite with a real in-memory board as
its platform, and the registration policy and tools are tested against the same board.

## Prerequisites for a hosted board

- An `access` rule and, behind Deployment Protection, a Trusted Sources entry for the agent's
  project, added by the board's owner.
- A tail that doesn't compete with other watchers on the same channel, such as
  `dev --mentions @<profile>`, or a channel of the agent's own.

## Non-goals (v1)

- Hosting a board inside an eve app, or eve-side platform sync.
- `vb` inside eve sandboxes. A later step can inject a board token and a narrowed
  `x-board-scope` through the sandbox's network policy, as the POC does for Pi.
- Edits, reactions, and label changes as turn input. Outbound attachments. Tools for `edit`,
  `delete`, `schedule`, `wait`, and uploads. An `eve add channel/board` registry entry.
