---
issue: https://github.com/vercel/eve/issues/1955
status: proposed
last_updated: "2026-08-12"
---

# Channel-routed Preview Deployment agents

## Decision

An explicit channel address may route the current message directly to a runtime
`RemoteAgentDefinition`. The route is deterministic: eve does not run the
local model to interpret an already-addressed message. The originating channel
continues to render the remote agent's events and owns its user-facing
attribution.

The first channel integration is Slack. An authored `onMessage` handler
recognizes a bot-owned Slack user group and imperatively routes the current
normalized message. A separate authored, approval-gated Slack tool registers
or unregisters Git branches as groups. The registration store remains Slack
user-group metadata; eve supplies routing and remote-agent lifecycle only.

```text
explicit Slack group mention
          │
          ▼
authored onMessage resolves registration
          │
          ▼
ctx.route(RemoteAgentDefinition, { attribution? })
          │
          ▼
coordinating channel session ── persistent remote handle ──► Preview Deployment
          │                                                    (eve channel)
          └── local channel adapter renders remote events
```

## Semantics

- Every channel address has one coordinating local eve session. An explicit
  remote route creates it if necessary, but does not run its local model.
- The session owns remote handles using the existing
  `subagentPersistentSessions` state machine. Channel routing does not require
  that experimental option; the option controls model-visible agent messaging,
  while the channel selects the handle directly.
- A remote handle is selected by the originating channel address plus normalized
  remote `url + path`. The definition description, auth resolver, headers, and
  attribution do not change identity.
- A later explicit route to the same target continues its remote conversation.
  A message without an explicit remote address uses normal local channel
  behavior. Local and remote model histories stay separate.
- Remote-routed input and output remain in the coordinating session's durable
  event stream with route metadata. The originating channel renders those
  events; the remote deployment's own Slack or other channel does not run.
- Attribution is framework-owned optional metadata. Channels choose rendering;
  Slack labels remote replies with the registered alias when present.
- A permanent continuation failure (404 or `SESSION_NOT_RESUMABLE`) visibly
  fails that message and drops the handle. The next explicit route starts a
  fresh remote session. A transient failure preserves the handle and does not
  automatically resend, matching persistent subagent behavior.
- Resetting the coordinating local channel session clears its remote handles.
  Exactly one remote target may be selected for an inbound message.

## Authoring API

### Provider-neutral routing

`onMessage` retains its current return type. Its context gains an imperative
operation that routes the current already-normalized input and consumes local
dispatch when the handler returns `null`:

```ts
export default slackChannel({
  async onMessage(ctx, message) {
    const registration = await resolveRegistration(message, ctx.slack);
    if (!registration) return { auth: defaultSlackAuth(message, ctx) };

    await ctx.route(registration.remote, {
      auth: defaultSlackAuth(message, ctx),
      attribution: { label: registration.alias },
    });
    return null;
  },
});
```

`ctx.route` uses the same normalized text, files, and channel context that a
normal Slack delivery would use. The integration may remove the recognized
address from text with the same normalization policy it uses for bot mentions.
It may be called at most once per inbound message.

The core operation is available to channel message contexts rather than through
an overloaded `ctx.to(...)`: `to` continues to mean handoff to another authored
channel, while `route` means deterministic routing of the current ingress.

### Vercel branch helper

The first-party Vercel helper belongs in the existing `eve` Vercel integration
surface:

```ts
import { defineVercelBranchAgent } from "eve/agents/vercel";

const preview = defineVercelBranchAgent({
  branch: "feature/preview-agent",
  description: "Preview of the agent on this branch.",
  forwardPrincipal: true,
});
```

It returns a normal `RemoteAgentDefinition`; no compiler variant is added. It
uses Vercel OIDC for transport and preserves `defineRemoteAgent`'s explicit
identity-forwarding default (`forwardPrincipal` is `false` unless authored).
It requires `description`, and normal remote dispatch—not registration—reports
later reachability failures.

The helper may ship only after a spike establishes a supported way to resolve a
branch to the current project's stable Vercel branch URL without copying
Vercel's alias-generation algorithm. `VERCEL_BRANCH_URL` covers the deployment's
own branch but not arbitrary branches; standard aliases also vary with suffixes,
staging prefixes, truncation, fork naming, and custom domains. If no supported
runtime resolver exists, keep the generic routing PR independent and defer the
helper rather than publish a brittle branch-only API.

### Slack registration tool

An author opts in by adding one tool file and sharing the same credentials with
its Slack channel:

```ts
// agent/tools/manage-preview-agent.ts
import { defineSlackPreviewAgentTool } from "eve/channels/slack";
import { slackCredentials } from "../lib/slack";

export default defineSlackPreviewAgentTool({
  credentials: slackCredentials,
  authorize({ action, branch, caller }) {
    return canManagePreviewAgents(caller, { action, branch });
  },
});
```

The path derives the model-visible tool name. The input is
`{ action: "register" | "unregister", branch: string }`; both actions always
require approval. The helper exposes the tool only to a root session begun by a
verified Slack human in a known workspace. The authored callback then
authorizes the action, branch, and caller before its approval is requested.

Register resolves the branch URL, verifies `GET /eve/v1/health` over Vercel
OIDC, then idempotently creates a Slack user group with the bot as its only
member. Its versioned description records the branch and resolved URL.
Unregister idempotently disables only a valid bot-owned group. Registration is
disabled unless the author adds this tool and callback.

Slack group routing trusts only enabled groups carrying a recognized marker,
created and last updated by the bot, with the bot as a member. Alias names are
derived from the bot and branch. Multiple recognized aliases in one message are
rejected; edited messages do not route.

## Boundaries

- The initial Vercel target is a branch Preview Deployment of the current
  project. Cross-project targeting, arbitrary URLs as the primary UX,
  project/team API tokens, PR-number resolution, and automatic alias lifecycle
  are out of scope.
- Branch registration is user-facing; deployment URLs are cached route data,
  never the primary registration input.
- URL registration is outside this proposal. Registered aliases route through
  native remote sessions rather than a client-side final-text relay.
- Full remote event delivery, including authorization and input events, is the
  intended routing contract. The first implementation may identify a narrow
  event-forwarding gap, but must not establish final-text-only relay as the
  public design.

## Delivery stack

### 1. Generic deterministic remote routing

Add the channel message-context route operation and remote-handle coordinator.
Extract shared create/continue/cancel transport logic from model remote dispatch
rather than duplicate it. Cover same-target continuation, isolated local and
remote history, per-message one-route enforcement, reset cleanup, permanent
and transient failure behavior, forwarded identity, callbacks, cancellation,
and channel event attribution. This is a patch public API change with docs and
a changeset.

### 2. Vercel branch target

Run the branch-resolution and redeploy-continuation spike. If the platform
provides a supported branch URL source, publish `eve/agents/vercel` with the
helper and focused Vercel integration tests. If not, do not merge a guessed URL
constructor; retain the generic route primitive and document the blocked helper.
This PR is contingent on the spike and includes a patch changeset only when a
public helper ships.

### 3. Slack registration and routing

Add the authored approval-gated management-tool helper, user-group registry
utilities, and an `onMessage` example that resolves a recognized group and
calls `ctx.route`. Cover exposure and execution authorization gates, approval,
health verification, idempotent register/unregister, ownership hardening,
mention normalization, ambiguity rejection, and explicit route continuation.
Add Slack docs and a patch changeset.

All three PRs require focused unit/integration coverage. The remote HTTP
boundary belongs in a scenario test; Slack's actual deployment path requires a
fixture-owned CI eval when the integration is ready.
