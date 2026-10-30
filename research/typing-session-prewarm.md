---
issue: "Maintainer-requested implementation"
status: implemented
last_updated: "2026-10-13"
---

# Prepare idle sessions while composing

Extend the existing `prewarm()` surface: create an unused session, or request a background
handoff of an existing idle session to the exact deployment serving the request. Applications
call it when typing starts; no second flag, webhook, project sweep, or promotion subscription
is required. React's live `prewarm` option and the Vue/Svelte imperative helpers share it.

The existing authenticated `POST /eve/v1/session/:sessionId` prepares the session with no
body or `{}`. Non-empty bodies retain message and input-response validation and delivery;
there is no separate preparation route. Ingress
compares the current inbox owner's run deployment, avoiding a wake-up for the same owner.
A reserved support attribute prevents sending new control payloads to older deployments.
A differing supported owner receives a durable hint scoped to its run ID. The owner reuses
its checkpoint, hook release, successor activation, and recovery protocol when idle. Real
messages supersede hints; active work is not interrupted. Preparation preserves the public
session ID, original stream, conversation history, and recorded timeout deadline.

Acceptance is not activation. Existing-session preparation never blocks Send and failures
leave the existing Send fallback usable. Immutable URLs and skew-pinned requests remain on
their pinned deployment; production and preview aliases follow whichever deployment accepts
the request. Non-affine Worlds and older owners safely skip preparation.

Validation covers ingress rollout/no-op behavior, authenticated transport, client failures
and Send races, and real Workflow owner transfer before a message with preserved expiry.
The Evo clone exercises two deployments and real Gateway timing. Checkpoint version 15
protects the new idle startup reason: older targets reject it instead of renewing expiry;
version 14 state needs no changes when upgraded by a newer successor.

Implemented on `codex/typing-session-prewarm`, based on main at `de7a408e4`.
Validation passed after endpoint consolidation: 326 focused route, client, and React unit
tests, repository typecheck, invariant guard, lint, and docs checks. Earlier validation
covered three Workflow integration tests, package build, and clone build. The fixture-owned
prewarm eval now uses the shared endpoint and runs in CI; it was not run locally.

The controlled Evo clone experiment promoted A to B during an idle period, then compared
three direct turns with three prepared turns for each cohort. Server POST-to-Gateway median
fell from 3.139s to 0.756s for first turns and from 3.003s to 0.724s for follow-ups.
Client Send-to-Gateway medians were 3.182s to 0.793s and 3.052s to 0.765s respectively;
client timing uses a clock calibration with ±57.5ms uncertainty. All six
prepared owners activated B before Send without new session events; all follow-ups retained
history. A tab loaded on A prepared B on typing, and immediate Send during preparation
succeeded. These are small clone samples, not production percentiles. Preparation moves
handoff work before Send and needs a typing head start to hide it fully.
These measurements used the preparation protocol before its HTTP endpoint was consolidated;
the route change does not alter the transfer protocol, and the latency experiment was not rerun.
