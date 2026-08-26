---
issue: "TBD"
status: proposed
last_updated: "2026-08-26"
---

# Multi-agent workspaces and workspace subagents

## Decision

An eve workspace is one deployable project containing an explicit set of root
agents. The workspace root declares its members in `package.json`; each member
owns an ordinary `agent/` directory and may optionally be a package-manager
workspace package. A workspace build compiles every member and gives every
member a stable, workspace-unique agent name.

```text
customer-operations/
├── package.json
├── pnpm-workspace.yaml
└── agents/
    ├── foreman/
    │   ├── package.json (optional)
    │   └── agent/
    │       ├── agent.ts
    │       └── subagents/
    │           └── workspace.ts
    ├── tasks/
    │   ├── triage/
    │   │   └── agent/
    │   │       └── agent.ts
    │   └── review/
    │       └── agent/
    │           └── agent.ts
    └── utilities/
        └── company-knowledge/
            └── agent/
                └── agent.ts
```

```json title="package.json"
{
  "private": true,
  "eve": {
    "agents": ["agents/**"]
  }
}
```

When deploying an eve workspace to vercel using `eve deploy`, services config
is automatically generated to allow each agent to be deployed behind separate
routes.

Agents within are able to easily declare other members of the workspace as
subagents. A member opts in by adding a file underneath their `subagents/`
directory containing a `defineWorkspaceSubagents()`.

Without arguments, this adds all other members of the workspace as subagents.
Users can filter which agents are included using path filtering.

```ts title="agents/foreman/agent/subagents/workspace.ts"
import { defineWorkspaceSubagents } from "eve";

export default defineWorkspaceSubagents({
  include: ["agents/tasks/*", "agents/utilities/*"],
  exclude: ["agents/triage"],
});
```

`defineWorkspaceSubagents()` functions by compiling the selected members into
remote subagent entries. To the calling model, they are named subagent tools; at runtime
they use the existing `defineRemoteAgent` execution protocol, including isolated
child sessions, durable callbacks, cancellation and reset, output schemas,
trace propagation, and optional forwarded caller identity.

The description of the agent is sourced from the original agent's description field --
it does not need to be duplicated in the consumer's code.

## Goals

- Let one project deploy several independently rooted eve agents as one
  operational unit.
- Give every workspace member a workspace-unique name and a useful
  parent-facing delegation description.
- Let a member expose a selected subset of workspace agents as subagent tools
  without hard-coding each peer URL and description in a separate
  `defineRemoteAgent()` file.
- Preserve remote-agent isolation, durability, observability, authentication,
  and identity-forwarding semantics.
- Support organized agent trees and future additions through path selectors.
- Keep distinct projects as the boundary for separate deployment lifecycles,
  credential isolation, and stronger operational isolation.

## Non-goals

- Discovering arbitrary agents at runtime by scanning the repository or calling
  other agents' inspection endpoints.
- Making workspace membership an authorization decision. The receiving agent's
  channel authentication and deployment transport policy remain authoritative.
- Replacing direct `defineRemoteAgent()` declarations for agents outside the
  workspace, hand-selected endpoints, or custom transport configuration.
- Providing an eve-managed reverse proxy, service mesh, or process supervisor
  for every self-hosted deployment.
- Inferring agent roles, tool descriptions, or capabilities from directory
  names.

## Workspace format and member identity

### Membership

The root package declares the agent application directories it owns:

```json title="package.json"
{
  "eve": {
    "agents": ["agents/**", "products/escalation"]
  }
}
```

Each path or glob match is a workspace-relative directory that contains an
`agent/` directory. The workspace root cannot also contain its own root
`agent/` directory. A member may have a `package.json`, but its package manager
workspace must claim that package; otherwise the root installation and member
build cannot be made reliable.

These are the core membership and build semantics in the PR #2043 stack:

- the root owns workspace discovery, environment loading, linking, and deploy;
- a member without a build script is built with `eve build` from its member
  directory;
- a member package with a build script runs that script instead;
- Vercel builds assemble one service per member when eve owns the service
  graph;
- outside Vercel, workspace build produces each member's normal output and the
  operator owns process startup and ingress routing.

A repository may be a package-manager monorepo without declaring `eve.agents`.
Such packages remain independent eve projects, with their own build, link, and
deploy lifecycle. The workspace declaration is deliberately not a generic
monorepo marker.

### Names and paths

A workspace member's final directory name is its **agent name**. Names must be
unique across the entire workspace, including nested groups.

The existing workspace deployment stack already uses this name for its public route and
service identity, so this proposal preserves that model:

```text
member directory                       agent name       public route
─────────────────────────────────────  ───────────────  ──────────────────────────────────
agents/foreman                          foreman          /eve/agents/foreman/eve/v1/*
agents/tasks/triage                     triage           /eve/agents/triage/eve/v1/*
agents/utilities/company-knowledge      company-knowledge /eve/agents/company-knowledge/eve/v1/*
products/escalation                     escalation       /eve/agents/escalation/eve/v1/*
```

If two members would otherwise be named `review`, authors must choose distinct
names such as `security-review` and `content-review`. This is an intentional
workspace constraint, as it simplifies routing and identity logic considerably.

The agent name is the shared identity in catalog entries, routes, generated
tool names, diagnostics, and trace attributes. The member's workspace-relative
path remains available for organization and selector globs, but moving a member
does not change its name, public route, or model-facing tool name.

### Descriptions and the catalog

Every workspace member that is declared as a subagent must author a non-empty root description:

```ts title="agents/utilities/company-knowledge/agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  description: "Answers questions from the company knowledge base and internal policies.",
  model: "openai/gpt-5.5",
});
```

The description tells another agent when to delegate. It should describe the
work the member can complete, not merely its organizational name.

Workspace compilation creates an internal catalog similar to:

```ts
type WorkspaceAgentCatalogEntry = {
  readonly name: "company-knowledge";
  readonly path: "agents/utilities/company-knowledge";
  readonly description: "Answers questions from the company knowledge base and internal policies.";
  readonly target: WorkspaceAgentTarget;
};
```

The exact serialized artifact is internal. The key invariant is that all member
artifacts arise from the same resolved catalog in one build. The catalog is
build input and inspection data, not a public live-discovery API. Fetching
`/eve/v1/info` from candidate agents would make tool availability depend on
network availability, runtime authorization, and deployment version skew.

## Workspace subagents

### Authoring API

`defineWorkspaceSubagents()` is valid only in a workspace member's
`agent/subagents/` source. It selects catalog members and expands one authored
source into multiple remote subagent tools:

```ts title="agents/tasks/triage/agent/subagents/workspace.ts"
import { defineWorkspaceSubagents } from "eve";

export default defineWorkspaceSubagents({
  include: ["agents/utilities/company-knowledge"],
});
```

Several selectors can organize a larger delegation surface:

```ts
export default defineWorkspaceSubagents({
  include: ["content-review", "agents/utilities/*"],
  exclude: ["experimental-knowledge"],
});
```

Workspace selection is static rather than session-dependent, so the compiler
can validate the complete tool set, descriptions, and targets before deployment.

The initial input is:

```ts
type WorkspaceSubagentsDefinition = {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
};
```

- `include` and `exclude` accept glob patterns, e.g. `agents/utilities/*`
- `exclude` wins over `include`.
- A member never selects itself, even when a selector matches it.
- An unmatched name or path is a build error. A glob that matches no members
  also fails by default: silently deploying an expected delegation surface with
  no tools is difficult to diagnose.
- Results are sorted by agent name and frozen into the deployment artifact.
  Adding a matching agent changes the tool surface only after a new build and
  deployment.

### Generated subagent names

Each selected member's workspace-unique agent name becomes its model tool name:

```text
content-review       → content-review
company-knowledge    → company-knowledge
```

The agent name remains the durable identity and the model-facing projection; no
path encoding or generated disambiguation is needed.

The compiler should make the source visible in `eve info` and agent-info as a
workspace-expanded remote subagent, including its agent name, member path,
generated name, description, route target, and source file. Diagnostics should distinguish:

- an invalid selector;
- an exact selector with no matching member;
- a glob with no matches;
- a selected member with no description;
- an invalid agent name;
- a workspace-subagent source authored outside a workspace.

### Dynamic subagent maps

Today a dynamic subagent selects one `defineAgent(...)`, one
`defineRemoteAgent(...)`, or `null`. Extend `defineDynamic()` to also accept a
record of named remote definitions:

```ts title="agent/subagents/specialists.ts"
export default defineDynamic({
  events: {
    "session.started": () => ({
      triage: defineRemoteAgent({/* … */}),
      "company-knowledge": defineRemoteAgent({/* … */}),
    }),
  },
});
```

The record keys are bare model tool names (`triage`, `company-knowledge`), not
`specialists__triage`. A single-definition return retains its existing
path-derived name; an empty record is the map equivalent of no subagents.

Each map entry needs a durable internal identity: resolver node plus record
key, such as `subagents/specialists#triage`. Session and turn selections persist
one map per resolver; a turn map replaces that resolver's session map, and an
empty turn map hides its session entries. Dispatch, continuation, cancellation,
reset, and inspection resolve this durable identity without rerunning the
resolver.

Dynamic entries must not collide with authored tools/subagents or entries from
another dynamic resolver. The initial map form permits only
`defineRemoteAgent()` entries. Mapping local `defineAgent()` values would make
several apparent agents share one subagent directory's resources, so local
agents remain one-per-directory.

`defineWorkspaceSubagents()` remains build-time/static, but can compile to the
same keyed delegation representation with catalog-derived names, descriptions,
and targets.

### Lowering and execution

The compiler expands the selected catalog entries into remote subagent nodes in
the calling member's ordinary subagent registry. It reuses the same lowerings
and runtime path as `defineRemoteAgent()`:

```text
agent/subagents/workspace.ts
          │
          ▼
workspace catalog + selector expansion
          │
          ▼
compiled remote subagent entries
          │
          ▼
subagent tool registry → remote session dispatch → callback / continuation
```

The resulting tools have the normal remote-agent contract.

`defineWorkspaceSubagents()` does not itself need to expose a URL, `auth`, or
`headers` field. It describes a same-workspace target. Direct
`defineRemoteAgent()` remains the explicit escape hatch for a different
endpoint or transport policy.

## Deployment and transport

### Vercel workspace deployments

When eve generates the Vercel Services graph, it already has a service and
public route for every workspace member. A workspace target resolves against
the current deployment origin plus the selected member's generated route:

```text
https://<deployment>/eve/agents/<agent-name>/eve/v1/session
```

The parent therefore does not need a deployment URL at compile time. This is
important for Preview deployments, whose final host name is unknown during the
build. The existing remote-agent callback mechanism continues to use the
parent's active deployment origin and callback route, so callbacks route back
to the calling service even when parent and child have different route
prefixes.

### Authentication and forwarded identity

Workspace membership does not relax remote-agent trust requirements. A
workspace call is an HTTP call from one independently running service to
another.

On Vercel, a workspace transport helper may select Vercel OIDC for the calling
service. The receiving member still owns its normal eve-channel authentication
policy. If the child needs to act as the end user, the caller must opt in to
`forwardPrincipal`, and the receiver must explicitly trust the verified
forwarding service through `eveChannel({ trustedForwarders })`.

This preserves the split already established for `defineRemoteAgent()`:

- transport authentication establishes which service made the request;
- forwarded-principal trust establishes whether that service may assert a user
  identity;
- only principal metadata crosses the hop; per-user tokens and connections are
  resolved by the receiving deployment.

A convenience helper must not silently make all workspace members trusted
forwarders or bypass a member's channel policy. Being in the same repository or
Vercel project is not a substitute for explicit receiver-side authentication
configuration.

### Self-hosting

A workspace build outside Vercel can build all member outputs, but it does not
create network routing or service identity. The operator remains responsible
for process topology, DNS or ingress, TLS, and authentication.

For self-hosting, workspace-subagent compilation requires an operator-provided
workspace target resolver. It maps a workspace agent name to a base URL and
supplies whatever outbound transport authentication the deployment
uses. The concrete public configuration is intentionally unresolved; it must
be deployment-level configuration rather than authored per calling agent so it
can vary between Docker Compose, Kubernetes, Nomad, and separate hosts without
baking secrets into the compiled catalog.

Conceptually:

```ts
type WorkspaceTargetResolver = (agent: { readonly name: string }) => {
  readonly url: string;
  readonly auth?: OutboundAuthFn;
  readonly headers?: HeadersValue;
};
```

The resolver is resolved at runtime like function-valued remote-agent URLs and
must not serialize credentials into durable state or the build artifact. A
self-hosted workspace build should fail clearly when it contains workspace
subagents but has no configured target resolver. It must not guess that an
`/eve/agents/...` route exists.

## Compatibility and boundaries

- A standalone agent cannot author `defineWorkspaceSubagents()`.
- An agent in a package-manager monorepo but outside a declared `eve.agents`
  workspace remains standalone for this feature.
- Existing local declared subagents and direct `defineRemoteAgent()` files are
  unchanged.
- A workspace build does not automatically expose every member to every other
  member. Each caller selects its own model-visible delegation surface.
- A workspace member description is required because a generated remote tool
  without a meaningful delegation description is not usable by the model.
- Moving a member preserves its agent name, route, and generated tool name,
  but can change path-based selectors. This is intentional: paths organize a
  workspace, while names identify its agents.

## Implementation plan

1. **Land and stabilize the workspace foundation.** Build on PR #2043 and its
   parent deployment stack: explicit `eve.agents` discovery, member package
   membership checks, workspace-root build/deploy ownership, and Vercel service
   assembly.
2. **Compile a workspace catalog.** Resolve every member's root config and
   required description before compiling individual consumer manifests. Keep
   catalog provenance and resolved route targets available to build planning
   and inspection.
3. **Add keyed dynamic subagent maps.** Preserve single-entry dynamic
   subagent behavior, then add durable resolver-node-plus-key identities,
   record selection snapshots, remote-entry validation, collision handling,
   and lifecycle lookup for map entries.
4. **Add `defineWorkspaceSubagents()`.** Permit it only for a workspace
   member's `subagents/` source; validate selectors against the catalog; and
   expand matches into deterministic remote entries using the keyed delegation
   representation.
5. **Resolve workspace members to remote targets.** Vercel derives each
   member's same-deployment route and service authentication from the generated
   workspace deployment. Other hosts must provide an explicit workspace
   routing/authentication integration; until one exists, use
   `defineRemoteAgent()` for non-Vercel targets.
6. **Expose topology in inspection and diagnostics.** `eve info` and
   agent-info should show workspace members, workspace-expanded subagents, and
   unresolved configuration errors without exposing credential material.

## Validation

- Workspace discovery: exact paths, `*` and `**` patterns, nested members,
  invalid segments, duplicate agent names, missing `agent/`, and child package
  membership.
- Build planning: member build scripts, plain eve members, Vercel services,
  route uniqueness, route-prefix preservation, and per-member outputs.
- Catalog: description required, deterministic order, source provenance, and
  no runtime network lookup.
- Dynamic subagent maps: single-entry compatibility, key-derived internal
  identities, session/turn replacement and empty-map hiding, duplicate and
  authored-name conflicts, durable dispatch and continuation, cancellation,
  reset, and map-entry inspection.
- `defineWorkspaceSubagents`: exact and glob selection, exclusion precedence,
  self omission, name and path-glob matching, empty/unmatched selector
  failures, agent-name preservation, stable tool order, and standalone
  rejection.
- Runtime: generated tools use remote dispatch, preserve output schemas,
  callbacks, continuation, task receipts, cancellation, reset, tracing, and
  token usage.
- Auth: same-workspace service authentication remains enforced; forwarding is
  rejected until both the sender and receiver opt in; no tokens or credentials
  appear in the catalog or durable action state.
- Deployment-shaped scenario: at least three nested members (foreman, task,
  utility), distinct prefixes, a delegated call and callback, and a selector
  that includes a future-facing category but excludes one task member.
- Self-hosting: target-resolution success, missing resolver failure, invalid
  resolved URL, and credentials kept runtime-only.
