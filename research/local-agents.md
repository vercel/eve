---
issue: https://github.com/vercel/eve/pull/2612
status: proposed
last_updated: "2026-08-26"
---

# Local agents: reference a top-level agent as a subagent

## Decision

Add a public `defineLocalAgent` that lets a subagent mount file reference
another top-level agent **in the same workspace and deployment** — the local
counterpart of `defineRemoteAgent`:

```ts
// foreman/agent/subagents/reviewer.ts
import { defineLocalAgent } from "eve";
import reviewer from "#agents/reviewer/agent/agent.ts";

export default defineLocalAgent(reviewer, {
  description: "Delegate code reviews here.",
});
```

The mount is an **address, not a config carrier**. The import is a
statically traceable link to the referenced agent's directory plus a
type-level connection for editors; the value it binds is never read. The
mount contributes only that link and the parent-facing `description`. The
referenced agent's config, instructions, tools, hooks, skills, connections,
sandbox, and nested subagents all come from its own directory, compiled once
per deployment. Delegation
dispatches to that agent in-process; the parent session that created the child
session owns it, exactly as subagent sessions work today.

## Motivation: the software factory

[`vercel-labs/eve-software-factory-template`][factory-template] ("Foreman") is
the shipped architecture behind [`ai-sdk-factory`][factory-blog], whose stated
design principle is _one agent per task, each with its own prompts, context,
and evals_. Today the grammar can only express that as one root with nested
limbs:

```text
agent/                      Foreman (root: channels, skills, brain)
  subagents/classifier/     agent.ts + instructions.md
  subagents/analyst/        agent.ts + instructions.md + sandbox.ts + tools/
  subagents/researcher/
  subagents/implementer/    own sandbox + checkout/push tools
  subagents/reviewer/       own sandbox + tools
```

Nesting makes each task agent a limb of Foreman rather than an agent:

- **No standalone entry point.** The reviewer cannot be developed, evaled, or
  run except through Foreman.
- **No direct triggering.** Subagents cannot declare `channels/`; a "review
  this PR" webhook aimed at the reviewer is not expressible.
- **No reuse.** A second factory wanting the same reviewer copies the
  directory or extracts a factory package, which cannot carry
  filesystem-discovered resources.

With local agent references the factory becomes a workspace of peers, with
Foreman as one orchestrator among them:

```text
factory/
  package.json                 imports: { "#agents/*": "./agents/*" }
  agents/
    foreman/agent/
      subagents/classifier.ts  defineLocalAgent → #agents/classifier
      subagents/reviewer.ts    defineLocalAgent → #agents/reviewer
      ...
    classifier/agent/          top-level: own evals, own dev loop
    reviewer/agent/            top-level: own channel when deployed standalone
    implementer/agent/
```

Each task agent is independently developable, evaluable, and optionally
deployable — while Foreman still composes them.

A concrete skeleton of this layout ships alongside this doc at
[`examples/factory/`](../examples/factory/README.md) (aspirational: it
illustrates the authoring experience and does not build until
`defineLocalAgent` exists).

## Semantics

### Reference, not embedding

An earlier draft of this proposal compiled the sibling _into_ the parent's
node tree (embedding). That model drags in problems the reference model does
not have:

| Concern                               | Embedding                                                            | Reference                                                                               |
| ------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Cycles (foreman → reviewer → foreman) | Infinite tree expansion; needs visited-set + error                   | Finite graph over top-level agents; legal mutual recursion, like remote loopbacks today |
| Diamond (two parents mount reviewer)  | Two divergent copies with separate state                             | One compiled graph, shared                                                              |
| Staleness                             | Parent's embedded copy stale until parent rebuilds                   | One copy per deployment                                                                 |
| Config fidelity                       | Mount could carry a mutated config that disagrees with the directory | Nothing to disagree: the directory is the only source                                   |

Under references, the compiled manifest contains the parent's agent graph
plus one compiled graph per reachable local agent (memoized by canonical
agent root), connected by reference edges. The parent's build compiles only
agents reachable from its mounts, not the whole workspace.

### Session ownership is unchanged

The creator of a session owns it, as today. When Foreman delegates to the
reviewer, Foreman's session creates and owns the child session — storage,
scoping, observability, cancellation all hang off the creator. The reference
edge only selects **which agent graph defines the child's behavior**: the
reviewer's entry point, instructions, tools, and sandbox.

These are two orthogonal identities:

```text
behavior identity   reviewer/           which agent's tree handles the work
ownership           foreman session S   who created the child session
```

Consequences:

- A reviewer session spawned by Foreman and a session on a standalone
  reviewer deployment share nothing. Different creators, different
  deployments — by design.
- Mutual references (foreman ⇄ reviewer) terminate the way the implicit
  `agent` self-recursion tool and remote loopbacks terminate today: when the
  models stop delegating, bounded by existing descendant-session limits.

### Root surfaces in a referenced agent

The referenced agent is authored as a root, so it may declare surfaces that
only make sense on the deployment that owns them:

| Surface                                                                                              | When referenced by a parent in this deployment                                                                                |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `channels/`                                                                                          | Inert. The HTTP surface belongs to the app that owns the deployment. Active when the agent is deployed standalone.            |
| `schedules/`                                                                                         | Inert, same reasoning.                                                                                                        |
| `experimental.workflow` / `experimental.tasks`                                                       | Applies to the agent's own runs. No stripping or rejection: the agent compiles as a root graph, so root-only config is legal. |
| Everything else (instructions, tools, hooks, skills, connections, sandbox, `subagents/`, extensions) | Fully active.                                                                                                                 |

This is a runtime activation policy, not a grammar restriction — the same
directory serves both roles without modification. Note the contrast with the
embedding model, where root-only config in a mounted directory is a compile
error in subagent position: a reviewer adopting `experimental.tasks` for its
standalone deployment would have broken every parent's build.

## Design

### Authoring API

```ts
interface LocalAgentOverrides {
  /** Surfaced to the parent as the delegation tool's description. */
  readonly description: string;
  // Later, mirroring remote agents: outputSchema, etc.
}

export function defineLocalAgent(
  agent: AgentDefinition, // link only; the value is never read
  overrides: LocalAgentOverrides,
): LocalAgentDefinition; // { kind: "local", ... }
```

The first argument exists for the type system and the editor — a compile
error if the sibling's `agent.ts` moves or stops exporting a config,
go-to-definition into the sibling, rename-safe refactors. Its runtime value
is deliberately ignored: config, instructions, tools, and sandbox all come
from the referenced directory, so there is exactly one source of truth and
no way for the mount to smuggle in a mutated config.

Symmetry with `defineRemoteAgent` (`packages/eve/src/public/definitions/remote-agent.ts`)
is deliberate: same mount position (a single file under `subagents/`), same
"link + description" shape, one locates by URL, the other by import. Swapping
a local reference for a remote one — e.g. when a factory splits one agent
into its own deployment — is a one-file change.

The mount filename still provides the parent-visible tool name
(`reviewer.ts` → `reviewer`), preserving the "name = path under `subagents/`"
rule; one agent may be mounted under different names by different parents.

### Reference resolution

Discovery resolves the reference statically, without importing authored
modules (the existing discovery invariant), the way extension mounts already
do (`parseExtensionMountSpecifier`,
`packages/eve/src/discover/extension-specifier.ts`):

1. Read the mount file text; match
   `export default defineLocalAgent(<ident>, …)` where `<ident>` is bound by
   an import.
2. Extract that import's specifier and resolve it: relative specifiers
   against the mount file's directory; `#…` specifiers via the nearest
   `package.json` `imports` map (readable statically); bare specifiers via
   package resolution.
3. The resolved module must be the sibling's `agent.ts`; its containing
   agent directory becomes the referenced agent root.

A single `imports` entry at the workspace root covers every agent with no
per-agent packaging:

```json
{ "imports": { "#agents/*": "./agents/*" } }
```

Per-agent `package.json` remains optional — only needed when an agent wants
its own dependencies. Agent identity falls back to the app-root basename as
it does today.

The static-shape constraint is inherited from extension mounts:
`defineLocalAgent(makeReviewer(), …)` or aliasing through intermediate
variables does not resolve. A `defineLocalAgent` call whose first argument
cannot be traced to an import fails discovery with a named diagnostic
("could not statically resolve the referenced agent") — never a silent
fallback.

Because siblings live in the same workspace, they share one lockfile and one
eve. Version skew between the referencing and referenced agent is
structurally impossible; no compatibility contract is needed. (Distributing
referencable agents through npm would need one — that is a non-goal here, and
if it ever matters it is closer to extensions than to this feature.)

### Compilation

New work, and the honest center of the lift:

1. **Multi-graph manifest.** The compiled manifest today is one agent tree
   under `ROOT_COMPILED_AGENT_NODE_ID` plus remote-agent nodes. It gains a
   set of _local agent graphs_, each compiled by the existing root-agent
   pipeline (so root-only config is legal), memoized by canonical agent
   root, plus reference edges `(parentNodeId, mountName) → localAgentId`.
2. **Reference nodes.** In the parent's tree, a local-agent mount compiles
   like a remote-agent node — a resolved reference plus description — not like a local
   subagent package. Compare `kind: "remote"` handling in
   `packages/eve/src/compiler/normalize-subagent.ts`.
3. **Delegation lowering.** The runtime subagent registry already lowers
   subagents to tools with a fixed input schema; a reference node lowers the
   same way but dispatches to the local agent's graph in-process. The
   dispatch-to-address shape exists for remote agents and in the
   subagents-as-tasks work (`dispatchToTaskAgentAddress` in the task
   branches); this adds a local address form.

What this deliberately does _not_ touch: session storage and scoping. Child
sessions are keyed by creator, as today; no new durable identity is
introduced, and no state migrates if a mount is renamed or a reference is
swapped for a remote agent.

### Dev server and packaging

- **Build inputs.** Referenced agent directories become inputs to the
  parent's build: bundling, fingerprinting, and cache invalidation must
  include them. Watch roots today derive from the app root only.
- **Deploy-time file availability.** On platforms that scope the build to a
  project root directory (e.g. Vercel Root Directory), a referenced sibling
  outside that root does not exist in the build container. Local dev works,
  deploy fails — the worst failure order. The build must detect a referenced
  agent outside the packaged file set and fail with an actionable error
  (point the project root at the workspace, or include the sibling).
  This needs an answer before the feature ships, not after.

## Side effects and objections

Raised in review; kept here with responses rather than silently resolved.

**Secrets centralization.** The factory blog's security model gives each
agent's sandbox "only the secrets the agent's specific task needs." Separate
deployments deliver that with per-project env; a single deployment referencing
all task agents holds the union of their secrets (implementer's push
credentials beside classifier's read-only token). References inherit this
from single-deployment architecture — they do not worsen it relative to
today's nested subagents, but they also do not fix it. Teams needing hard
secret isolation should split those agents into deployments and use
`defineRemoteAgent`; the one-field swap makes that migration cheap. The docs
for this feature should say so explicitly.

**Reverse-dependency visibility.** A referenced agent does not know who
references it. A change to the reviewer can break Foreman's build (e.g. a
malformed tool), discovered at Foreman's build time by a team that may not
watch Foreman's CI. Same-workspace scoping bounds this — it is the standard
monorepo shared-package problem, solvable with workspace-level CI — but it is
new surface for agent directories, which today have exactly one consumer.

**Eval fidelity.** Standalone reviewer evals certify the reviewer's own
behavior. Behavior under delegation differs by construction: different
creator, different inbound message framing. Reference semantics keep the gap
small (same graph, same instructions, same tools — unlike embedding, where
overrides could fork config), but composed evals in the parent remain
necessary for delegation-specific behavior.

**Does this need grammar at all?** The factory works today; standalone
iteration could instead come from tooling (`eve dev --subagent reviewer`).
But tooling cannot give a nested subagent a channel, an independent
deployment, or reuse across parents — those are structural. The tooling route
also entrenches the parent as the only addressable unit, which is the thing
the factory architecture strains against.

## Alternatives considered

1. **Embedding** (compile the sibling into the parent's tree — this
   proposal's earlier draft). Rejected: cycle machinery, diamond duplication,
   staleness, and a config-fidelity hole (the mount could carry a mutated
   config disagreeing with the directory), all absent under references.
2. **Value import** (`defineSubagent(reviewerConfig)`). Silently lossy:
   `defineAgent` is an identity function
   (`packages/eve/src/public/definitions/agent.ts`), and a single-file
   subagent's manifest carries only the config module
   (`packages/eve/src/discover/discover-subagent.ts`,
   `discoverSingleFileSubagent`) — the directory's resources never transfer.
3. **Symlinks under `subagents/`.** Fragile against discovery's directory
   checks, platform-dependent, invisible in review.
4. **Extension mounts.** Extensions deliberately cannot carry `agent.ts`, a
   sandbox, instrumentation, or memory
   (`packages/eve/src/discover/discover-agent.ts`) — they contribute
   capabilities, not agent identity.
5. **Remote agents for everything.** Full fidelity, but forces a deployment
   per task agent and a network hop for in-workspace composition; the factory
   template's five task agents would need five deployments before the first
   delegation works.

## Open questions

1. **Specifier forms at v1:** `#…` imports-map aliases and relative paths
   for certain; are bare package specifiers worth supporting at all, given
   agents need no per-agent packaging?
2. **Workspace boundary definition:** what exactly bounds "same workspace" —
   the directory owning the `imports` map, the pnpm/npm workspace root, or
   any resolvable path? The deploy-time file availability problem suggests a
   root that owns all referenced agents.
3. **A blessed `agents/` convention:** should eve bless
   `<workspace>/agents/<name>/` as the layout (enabling workspace-aware
   tooling and short names), or stay layout-agnostic and let the imports map
   carry the convention? Proposed: layout-agnostic in v1; revisit with
   workspace-aware `eve dev`.
4. **Channel/schedule inertness:** is inert-when-referenced the right
   default, or should a deployment be able to opt into activating a
   referenced agent's channels (making one deployment host several
   addressable agents)? The latter is powerful — it is most of the way to
   multi-agent apps — but expands scope considerably.
5. **`eve dev` at the workspace root:** should the dev server understand a
   workspace of agents (start the parent, resolve references, watch all
   referenced roots), and is that v1 or follow-up?
6. **Naming:** `defineLocalAgent` (symmetry with `defineRemoteAgent`) vs.
   `defineSiblingAgent` / `defineWorkspaceAgent`. This doc uses
   `defineLocalAgent`.

[factory-template]: https://github.com/vercel-labs/eve-software-factory-template
[factory-blog]: https://vercel.com/blog/building-a-software-factory-for-ai-sdk
