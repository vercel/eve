---
issue: https://github.com/vercel/eve/issues/982
status: proposed
last_updated: "2026-07-20"
---

# Anchored threads must resume across the whole turn

A follow-up delivered to an anchored channel thread while the session's
turn is still running forks a new session instead of resuming, and the
forked run dies with `HookConflictError` when both runs claim the thread
token. Any user replying quickly in an anchored thread mid-turn can hit
this; it surfaced as a deterministic `tui-connection-auth-user` failure
once a fixture model change moved the smoke's follow-up inside the
exposure window (bisect-verified on PR #881).

## Cause

The session's delivery hook is one rotating slot.

```
session start        mid-turn (connection auth)        park
     │                        │                          │
     ▼                        ▼                          ▼
 anchor claimed ──rekey──▶ auth token claimed ──rekey──▶ anchor reclaimed
                 (anchor DISPOSED — thread deliveries
                  now HookNotFound → new session)
```

- `execution/workflow-entry.ts` claims the anchored thread token before
  the first turn, so resume works while the session is parked.
- `execution/turn-control-receiver.ts` rotates the slot to in-turn
  continuation tokens (`deliveryHook.rekey(...)`), and
  `execution/session-delivery-hook.ts#rekey` disposes the previous hook
  once the candidate is claimed. While rotated away, the thread token
  resolves to nothing: `resumeHook` → `HookNotFoundError` →
  `RuntimeNoActiveSessionError` → the channel route starts a new
  session. Both runs later claim the anchor; the loser fails terminally.

## Invariant to establish

A session anchored to a channel thread is resumable by that thread token
for the session's entire lifetime — parked or mid-turn.

## Directions

1. **Durable anchor, additive continuations.** The anchor hook stays
   claimed for the session; in-turn continuation tokens become additional
   armed hooks rather than replacements of the single active slot. The
   hook state machine already tracks `retired` states for reads — the
   change is that rotation must not dispose the anchor's claim.
2. **Attributed fallback on miss.** On `HookNotFoundError` for a token
   the world can attribute to a live run, enqueue the delivery for that
   run instead of creating a session. Weaker: keeps the window, moves the
   failure.

Direction 1 matches the invariant; direction 2 is a mitigation if hook
multiplicity is costly in the workflow world.

## Repro

With `apps/fixtures/agent-tui-client` on `openai/gpt-5.6-luna` +
`reasoning: "medium"` (the pre-`8c161c54` fixture):

```sh
cd packages/eve && pnpm run build:js
PORT=3210 node test/tui-client/tui-connection-auth-user.ts
```
