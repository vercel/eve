---
issue: https://github.com/vercel/eve/issues/2347
status: in-progress
last_updated: "2026-08-24"
---

# Programmatic agent sources

## Decision

Compile one authoritative agent source graph. Filesystem discovery, extension
packages, extension overrides, framework-owned programmatic modules, and
subagent source nodes all produce candidates for path-derived slots. Candidate
construction gives every executable source an explicit filesystem or
programmatic binding before its definition can load. One composer selects a
winner for each slot before normalization, and the ordinary compiler
normalizes only those winners.

```text
framework modules ───────┐
extension packages ──────┤
extension overrides ─────┼─> classify + compose ─> effective source graph
application sources ─────┤                                │
subagent source nodes ───┘                                ├─> compiled manifest + bindings
                                                          ├─> composition + route plans
                                                          ├─> generated and hydrated maps
                                                          ├─> runtime + Nitro
                                                          └─> CLI + agent-info + tests
```

Logical identity and physical storage are separate. A logical path selects an
eve slot and derives its public name. A backing binding says how to load that
slot. `agent/tools/search.ts` and an immutable in-memory namespace registered
at `tools/search.ts` therefore compile identically without pretending that the
programmatic module exists on disk.

The framework API is internal. Programmatic modules export ordinary public eve
definitions: `defineTool`, `defineDynamic`, `defineChannel`, `defineSandbox`,
`defineAgent`, and the existing connection, hook, schedule, instruction, and
skill factories. They never construct `Compiled*` or `Resolved*` records.
Production runtime behavior continues to live in the `eve` package; generated
module maps only bind statically reachable module namespaces.

The compiled manifest, required bindings, persisted composition report,
compiler-owned channel route plan, and closed kernel and host capability plans
are the only downstream authority. An active module-backed source is owned by
its binding. An active non-module source is owned by its explicit compiled
source record. A losing or disabled source is owned by its self-contained
composition entry. No second winner-owner index or out-of-band origin table may
exist.

Every ordinary framework default is a first-class eve primitive at a canonical
logical path, including the default `agent.ts`, sandbox, home page, and public
health endpoint. Native execution may implement a selected primitive, but it
may not create that primitive's presence independently of the source graph.
Model-visible kernel capabilities and host registrations that cannot be
ordinary sources live in separate, typed, exhaustive inventories.

This supersedes the runtime-tool contribution seam in #2347. Runtime
contribution is too late for channels, schedules, sandboxes, host routes,
bundling, and inspection, and would create another collision, durability, and
dispatch system for tools.

## Problem

The compiler already tracks `logicalPath` and `sourceId`, but module loading
still assumes every source lives at `agentRoot + logicalPath`. Framework and
extension features work around that assumption at different layers:

- framework tools and channels fabricate resolved definitions and merge them
  after compilation;
- `connection_search` appends a synthetic dynamic resolver and reconstructs
  discovered tools from both durable state and message history;
- Nitro creates a second framework-channel merge for host routes;
- extension packages compile, prefix, rebase, merge, disable, and deduplicate
  each primitive separately after the application manifest has compiled;
- the default sandbox appears through a runtime fallback rather than an
  effective `sandbox.ts` source;
- the default agent config is synthesized inside normalization rather than
  selected as an `agent.ts` source;
- the home page and public health endpoint are native host routes that bypass
  channel source composition and use a second route-precedence system;
- subagent ownership survives in a module-global `WeakMap` while its
  composition report is discarded;
- two agent-info builders re-create framework status from different inputs;
- native harness tools are represented by metadata stubs that are not the
  definitions the harness advertises or executes.

The result is duplicate machinery with inconsistent identity. Replacement,
disablement, route order, source provenance, cold-start loading, and inspection
depend on which path created a definition. The refactor succeeds only when
those parallel paths are deleted, not hidden behind a new registry.

## Scope

This work will:

- introduce source-neutral candidate, composition, and loading boundaries;
- require complete module bindings at artifact construction, compilation, and
  load, including bindings created for application candidates before their
  definitions execute;
- compose framework defaults, extensions, overrides, and application sources
  once, including local subagent source nodes;
- compile one effective manifest consumed by runtime, Nitro, bundling, and
  inspection;
- migrate ordinary framework tools, `connection_search`, framework channels,
  home, health, the default sandbox, and the default `agent.ts` to
  programmatic eve modules;
- separate public primitive definitions, execution implementations, and native
  kernel code so each ordinary default has one definition value;
- replace scattered native-tool knowledge with one executable, exhaustive
  kernel capability inventory covering preparation, advertisement,
  materialization, dispatch, prompt flags, and inspection;
- limit non-source host behavior to an explicit closed host inventory and move
  process readiness away from the replaceable public health route;
- replace agent-info v2 with a truthful v3 projection;
- remove the old framework, extension-composition, fallback, and inspection
  paths in the same implementation.

The implementation does not expose a public registration API, serialize
functions, mutate a compiled graph, create programmatic subagent nodes, or
virtualize markdown and skill asset files. Programmatic modules may be applied
to already-discovered local nodes. The framework registry receives a narrow
exception to provide the default config slot, but no registration may
recursively introduce nodes, extensions, or raw workspace content.

## Source model

### Programmatic modules

Programmatic sources declare immutable, lazily loaded module namespaces at
virtual agent-relative paths:

```ts
type ProgrammaticModuleNamespace = Readonly<Record<string, unknown>>;

interface ProgrammaticAgentModule {
  readonly exportName?: string;
  readonly loadNamespace: () => Promise<ProgrammaticModuleNamespace>;
  readonly logicalPath: string;
  readonly semanticRevision?: string;
}

interface ProgrammaticAgentSource {
  readonly id: string;
  readonly modules: readonly ProgrammaticAgentModule[];
  readonly revision: string;
}

function defineProgrammaticAgentSource(input: ProgrammaticAgentSource): ProgrammaticAgentSource;

interface AgentSourceRegistration {
  readonly applyTo: "root" | "all-local-nodes";
  readonly source: ProgrammaticAgentSource;
}

function createAgentSourceRegistry(
  registrations: readonly AgentSourceRegistration[],
): AgentSourceRegistry;
```

`logicalPath` is a normalized POSIX path relative to an agent root. It must
match the existing grammar, cannot be absolute or traverse with `..`, and may
select only module-backed slots. The path derives identity; there is no `name`,
slug, kind, protocol, or precedence field.

The selected export follows existing ESM semantics and may be a zero-argument
sync or async factory. Construction shallow-copies and freezes source and
module metadata without invoking `loadNamespace`. The loader returns the exact
namespace and preserves brands, symbols, functions, and durable callback
metadata. Programmatic source IDs derive deterministically as
`<source.id>:<logicalPath>` and must be unique within each node.

Each source also declares a non-empty immutable `revision`. The revision
identifies the exact registered implementation, not a mutable deployment
label. A package-backed or generated registry uses its immutable build
revision. An in-memory registry uses a fresh opaque generation revision because
closed-over callback state cannot be derived faithfully from function source
text. Bindings persist that revision, module-map identity includes it, and
loaders reject a same-ID registry at a different revision before evaluating any
namespace. Reusing a source ID after changing callbacks therefore cannot
hydrate stale executable code under an unchanged artifact.

A module may declare a non-empty `semanticRevision` when its source-wide
revision intentionally covers unrelated modules. The compiled backing keeps
both values: the source revision still authenticates registry loading, while
selected-backing identity uses the module revision when present. The framework
default sandbox uses an explicit stable token so unrelated eve source changes
do not discard durable sandbox state.

Registries are explicitly assembled, statically imported, and immutable before
compilation. They are not global, side-effect-populated, or mutable runtime
registries. `root` applies only to the application root. `all-local-nodes` is a
finite overlay applied after filesystem and extension nodes are discovered; it
rejects `agent.ts`, `subagents/**`, `channels/**`, `schedules/**`, and
`extensions/**`. A closed internal framework registration is the narrow
exception that may provide the default `agent.ts` for every already-discovered
local node. Arbitrary programmatic sources cannot use config to expand the
graph recursively.

Framework registry modules contain literal dynamic imports inside namespace
loaders. They do not statically import or evaluate definition modules while
constructing the registry. Compilation and every module-map implementation
invoke loaders only for selected programmatic bindings, so a shadowed source
cannot execute during compilation or cold-start hydration.

### Physical backing

Every module candidate carries its logical identity and an explicit physical
binding:

```ts
type AgentSourceOwner =
  | { readonly kind: "application" }
  | { readonly feature: string; readonly kind: "framework" }
  | {
      readonly kind: "extension";
      readonly namespace: string;
      readonly packageName: string;
    };

type AgentSourceLayer =
  "framework-default" | "extension-package" | "extension-override" | "application";

interface AgentModuleCandidate {
  readonly backing:
    | {
        readonly externalDependencies: readonly string[];
        readonly extensionScope?: {
          readonly namespace: string;
          readonly sourceRoot: string;
        };
        readonly kind: "filesystem";
        readonly sourcePath: string;
      }
    | {
        readonly kind: "programmatic";
        readonly moduleId: string;
        readonly registryId: string;
        readonly revision: string;
        readonly semanticRevision?: string;
      };
  readonly layer: AgentSourceLayer;
  readonly logicalPath: string;
  readonly nodeId: string;
  readonly owner: AgentSourceOwner;
  readonly sourceId: string;
}
```

`logicalPath` is never used as an import path. Filesystem loading uses
`sourcePath` plus its external-dependency and extension scope. Programmatic
loading uses the exact registry/module/revision tuple. Missing or
revision-mismatched programmatic bindings fail without probing a virtual path
on disk or invoking a namespace loader. `sourceId` remains stable provenance;
provider kind and precedence are never inferred from it.

Raw filesystem resources retain their physical source paths and participate in
the same slot composition, but they do not gain a programmatic backing in this
version.

### Required compiled bindings

Bindings are load-critical data and must not live only in optional compile
metadata. Each compiled node owns a total binding table keyed by the same
`sourceId` used by its manifest references:

```ts
interface CompiledAgentNode {
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly manifest: CompiledAgentNodeManifest;
}

interface CompiledModuleBinding {
  readonly backing: AgentModuleCandidate["backing"];
  readonly logicalPath: string;
  readonly owner: AgentSourceOwner;
}

interface EffectiveAgentNodeSourceGraph {
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly composition: AgentSourceComposition;
  readonly manifest: AgentSourceManifest;
}
```

Bindings and composition are required inputs to every compiled node and root
manifest constructor. They are not optional fields filled in by serialization
or reconstructed from a normalized manifest. Every serialized node and root
manifest carries `sourceComposition`; there is no empty default. Construction
fails unless every module-backed manifest reference has exactly one binding,
logical paths agree, extension-owned filesystem bindings carry
`extensionScope`, and every binding is referenced. The same semantic validator
runs after schema parsing in every disk and bundled artifact loader, before
module-map hydration.

The binding table participates in artifact versioning and hashing. Development
hydration, generated module maps, bundled artifacts, materialized artifacts,
and cold-start reconstruction all read this same table. Optional diagnostic
metadata may summarize compilation, but no process can load or inspect an
agent without its bindings and composition.

Generated maps emit ordinary static imports for filesystem modules and
statically reachable registry lookups for programmatic modules. The resulting
`CompiledModuleMap` remains the only namespace map used by graph resolution.
`logicalPath` is never joined to `agentRoot` after candidate construction, and
`sourceId` is opaque outside equality, diagnostics, serialization, and module
map lookup.

### Binding-safe compilation phases

Every application, extension, and framework candidate receives its backing,
owner, and physical scope when the candidate is created. Application sources
are not reconstructed after normalization. Compilation proceeds in two
binding-safe phases because the selected config supplies build settings:

1. Collect and compose structural and config candidates, create the selected
   config binding, and then load and normalize that config.
2. Derive build, task, and external-dependency settings from the selected
   config.
3. Construct and compose the remaining candidates with those settings and
   create the complete selected binding table.
4. Load and normalize only selected, bound non-config definitions.

The config normalizer receives only its selected candidate and required
phase-one binding. Module-backed primitive normalizers require a binding.
Direct injected definitions are not a production escape hatch; the only
already-evaluated value passed between phases is the compiler-owned selected
config. Losing candidates receive no compiled binding and never execute.

`createProgrammaticCompiledModuleMap` is asynchronous and resolves only the
programmatic bindings present in the compiled manifest. Generated,
materialized, bundled, hydrated, and in-memory maps await those same selected
loaders and expose the same `(nodeId, sourceId)` set.

## One composition pass

The composer operates on canonical logical slots before loading or normalizing
definitions. Precedence is:

```text
framework default < extension package < extension override < application
```

For each slot it:

1. classifies every candidate with the existing path grammar;
2. rejects same-layer duplicate candidates;
3. selects the highest-precedence candidate without executing any candidate;
4. loads the selected export and, if it is a disable sentinel, validates that
   it targets a lower replaceable candidate before omitting the slot;
5. normalizes only the selected non-disabled candidate;
6. records the candidates, winner, replacement, or disablement in one compiler
   composition report persisted with the compiled node.

An invalid winner fails compilation and never falls back to the shadowed
candidate. Disable sentinels and shadowed definitions do not survive in
compiled or resolved runtime types. The composition report is for compiler
diagnostics and inspection provenance; runtime behavior never recomposes it.

The composition report does not duplicate active ownership. An active
module-backed winner points to its required binding; an active non-module
winner carries owner on its compiled source record. A shadowed entry stores the
loser's complete source descriptor and only the winning `sourceId`. A disabled
entry stores the selected disable source descriptor because no active binding
exists. `sourceComposition.sourceOwners`, full duplicate winner descriptors,
and other parallel owner indexes are forbidden.

Identity uses the existing canonical equivalence rules: `.js` and `.ts`
variants select the same slot, connection file/folder forms collide, and tool
names flattened from distinct logical slots retain their uniqueness errors.
Those public-name collisions fail during compilation after slot composition;
they do not gain cross-layer precedence. Dynamic outputs remain subject to the
existing runtime lifecycle rules after their resolver source has composed.

### Subagent source nodes

Local subagent identities participate in the same node composition report as
module primitives. Each selected subagent carries explicit owner, backing,
logical path, source ID, and child manifest into recursive compilation. The
parent binding table does not pretend to own a child node reference.

Nested extension subagent records are fresh and immutable for each mount, so
mounting one extension twice cannot share provenance. The separate
`composeSubagentSources` report, module-global origin `WeakMap`, and any
out-of-band subagent origin table are removed. Shadowed and supported disabled
subagent candidates remain self-contained composition entries for diagnostics
and inspection.

### Extensions are source projection, not a second compiler

An extension mount projects each package or override source into its final
consumer-visible logical path before composition. For example, a package
module at `tools/search.ts` mounted as `crm` becomes
`tools/crm__search.ts`; its filesystem backing still points to the package's
actual file. The ordinary tool normalizer then derives `crm__search` from that
canonical path exactly as it would for an application file.

The same projection applies to every extension-supported primitive and eligible
subagent source. Existing extension capability restrictions remain validation
policy on projected candidates: an extension still cannot enable root-owned
Workflow or configure the consumer's web-search provider. Consumer override
files project to the same slots at the higher `extension-override` layer, and a
root application source at the final qualified path may replace either.

This replaces per-primitive extension compilation, rebasing, prefix mutation,
merge functions, disable passes, and name-based deduplication. Qualification
happens once in path space; normalization happens once after selection.

### The effective manifest is authoritative

The result is one effective compiled graph containing node manifests, required
bindings, the composition report, a compiler-owned channel route plan, and the
prepared kernel capability plan. Every downstream consumer reads it:

- graph resolution registers only compiled resources;
- Nitro registers only the compiled ordered channel routes;
- development and production module maps load only required bindings;
- CLI, Vercel build summaries, and agent info project the same resources;
- no consumer imports a framework tool or channel catalog and merges it again.

Channel modules compose by logical slot before route expansion. The compiler
then preserves selected module order and produces one required route plan with
effective routes, generated preflights, and retained shadowed routes. Runtime
dispatch, WebSocket detection, CORS handling, Nitro development and production
registration, and inspection consume that plan without a second drop or merge.

The test-only in-memory compiler must also become a source provider for this
pipeline. It registers programmatic sources whose lazy loaders return its
namespaces; it may not inject evaluated definitions or construct compiled
descriptors or empty module-map entries by hand. Tests that need realistic
compilation use the same composer and normalizers as production.

## Framework migration

### Primitive ownership boundaries

Ordinary public definitions and schemas live under `public/tools` or another
primitive-owned shared module. Execution-only implementations and durable
state live under `execution/tools` or an equivalent execution-owned boundary.
Native capability implementations live under `kernel/<capability>` or their
capability-specific execution modules.

Each ordinary default has exactly one definition value. Its framework source
module and `eve/tools/defaults` import that same value. Moving modules must
preserve durable state key identity for todo, read-before-write, skill,
connection-search, compaction, and task behavior. Import guards enforce that
public modules do not import `runtime/`, ordinary framework sources construct
only public definitions, and native tools are reachable only through the
kernel inventory.

The mixed `runtime/framework-tools` subsystem and transitional re-export
wrappers are deleted after legitimate modules move. “Framework tool catalog”
terminology no longer describes ordinary primitives.

### Default agent config

Register one immutable programmatic default `agent.ts` source for every local
node. It exports the ordinary default agent definition with the existing
default model. Config participates in phase-one composition before the winning
export executes. An authored `agent.ts` shadows the framework source without
invoking the framework namespace loader.

The selected config binding and owner are persisted with its composition
history, so filesystem and in-memory agents report the same provenance. The
framework's narrow config registration cannot introduce subagents, extensions,
or other recursive graph content. Remove the synthesized
`{ model: DEFAULT_AGENT_MODEL_ID }` normalizer branch, undefined-config-source
inspection conventions, and config loading that bypasses the total binding
table.

### Ordinary tools

Author `bash`, `read_file`, `write_file`, `todo`, and `web_fetch` once as public
`defineTool` values. Register those exact values at canonical paths and export
them from `eve/tools/defaults`. `glob` and `grep` remain opt-in exports rather
than dormant framework defaults.

Their executors receive ordinary `ToolContext`. Remove the public/internal
converter, duplicate resolved-definition constants and wrappers, and the
`sourceId.startsWith("eve:")` calling convention. Framework ownership comes
from the binding, not a string prefix.

Register the public web-search sentinel at `tools/web_search.ts`. An
application `webSearch(...)`, `defineTool(...)`, or `disableTool()` at that
identity composes normally; model/provider materialization remains an explicit
kernel capability described below.

`load_skill` becomes an ordinary public definition at
`tools/load_skill.ts`. Its executor reads an eve-owned skill-catalog context
provider instead of closing over resolved skills. The kernel inventory may
still gate advertisement on whether the node can load a static or dynamic
skill, but it does not fabricate a second definition. Dynamic-skill and
cold-start behavior use the same compiled source and selected binding; no
special source type or native fallback remains.

### `connection_search`

Register the existing public `defineDynamic` value at
`tools/connection_search.ts` for all local nodes. It becomes an ordinary
compiled resolver and retains the existing dynamic lifecycle for validation,
qualification, atomic replacement, collisions, durable callbacks, and replay.

`ConnectionSearchResultsKey` becomes the sole durable record of discovered
connection tools. Delete message-history rescanning, context/history merging,
the synthetic `connection` slug, the special graph append, and the separate
framework dynamic registry. Existing sessions without the durable key search
again; no compatibility fallback reconstructs results from history.

Connection filtering, auth and approval behavior, partial/all-failure handling,
long qualified names, and persisted callback identity remain unchanged.

### Default sandbox

Register a public `defineSandbox({})` value at `sandbox.ts` for all local nodes.
An authored `sandbox.ts` replaces it through normal source composition. The
standard semantics of a selected sandbox definition with no explicit backend
still choose `defaultSandbox()` for the current environment, but graph
resolution never invents a framework sandbox. Every successfully compiled
local node contains exactly one selected sandbox with a source ID and binding;
disabling the only candidate cannot be repaired by a runtime fallback.

This removes the no-source fallback and gives inspection, hashing, extension
scope, and replacement one truthful sandbox source. Sandbox workspace assets
remain filesystem resources and are not virtualized.

### Framework channels

Register a root-only zero-argument factory returning
`eveChannel({ auth: [vercelOidc(), localDev(), placeholderAuth()] })` at
`channels/eve.ts`. A factory preserves the current per-resolution lifecycle.
An authored channel or disable sentinel at that identity replaces or removes
the complete default channel.

Register the six callback handlers as root-only, one-route `defineChannel`
factories at exact paths:

- `channels/eve/v1/connections/callback/get.ts`;
- `channels/eve/v1/connections/callback/post.ts`;
- `channels/eve/v1/connections/callback/legacy/get.ts`;
- `channels/eve/v1/connections/callback/legacy/post.ts`;
- `channels/eve/v1/callback/post.ts`;
- `channels/eve/v1/task-input/post.ts`.

The six identities remain independently replaceable and disableable. URLs,
legacy support, authorization, status codes, and response bodies do not change.
The definitions carry truthful HTTP adapter metadata and use the ordinary
channel handler path, eliminating framework-only route construction and fetch
dispatch.

Add root framework channel modules at `channels/home.ts` and
`channels/eve/v1/health.ts`. They use ordinary `defineChannel`, `GET`, and
`HEAD` values for the home page and public health protocol. Metadata needed by
the home handler comes from an eve-owned context provider, not a special source
kind or build-time native route. The default modules preserve the current
response bodies, status codes, and authentication behavior.

Home and health are replaceable and disableable through ordinary source
composition at those exact paths. This is an intentional pre-1.0 breaking
change. A replacement for health owns its implementation but must return the
public `HealthResult` payload on a successful response. `Client.health()`
validates successful JSON with `HealthResultSchema`; a non-success response
throws `ClientError`, and a successful response with an invalid payload throws
`HealthResponseError`. No client or host code reaches a hidden native health
fallback.

#### One compiled route plan

Source-slot composition runs before concrete route planning. The manifest owns
one required plan:

```ts
interface CompiledChannelRoutePlan {
  readonly effective: readonly CompiledChannelDefinition[];
  readonly preflight: readonly CompiledChannelPreflightDefinition[];
  readonly shadowed: readonly CompiledShadowedChannelRoute[];
}
```

Each shadowed route records its concrete method/path identity, the winning
`sourceId`, and the loser's self-contained source descriptor. Each generated
preflight records normalized CORS options and the selected source IDs that
caused it. The artifact validator rejects duplicate effective identities,
dangling route sources, invalid preflight causes, and overlap with a reserved
host registration at construction and load.

Different compiled channel sources that normalize to the same method and path
pattern use deterministic compiled order and first-wins selection. The loser
is retained, and the compiler emits `compile/channel-route-shadowed`. The same
source emitting one identity twice is instead
`compile/channel-route-duplicate`. Nitro and runtime code never perform a
second silent drop.

Route pattern identity ignores parameter names. Method sets must intersect,
`ALL` intersects every HTTP and WebSocket method, and a static path inside a
parameter pattern's match space overlaps that pattern. A collision with a
closed host registration is `compile/reserved-route-collision`.

CORS preflights derive only after ordinary route winners are selected.
`WEBSOCKET` does not produce preflight. An explicit selected `OPTIONS` route
that collides with a generated preflight fails with
`compile/channel-preflight-collision`. Selected CORS-enabled methods at one
path must have identical normalized options or fail with
`compile/channel-cors-conflict`; identical options produce one derived
`OPTIONS` record.

Replacing or disabling `channels/home.ts` or
`channels/eve/v1/health.ts` is source-slot composition. An unrelated channel
that declares the same concrete route follows route ordering and does not gain
source precedence.

#### Closed native host inventory

Generic dispatch of a selected compiled channel is execution machinery, not a
separately registered default. Host behavior outside ordinary sources is
limited to four typed categories:

- Workflow transport;
- development control and readiness transport;
- the schedule/cron platform bridge;
- a non-HTTP production process-readiness handshake.

The application and development hosts register or reserve only these inventoried
HTTP entries:

- `ALL EVE_WORKFLOW_FLOW_ROUTE_PATH`;
- `GET EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH`;
- `GET` and `POST EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH`;
- `POST EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH`;
- `POST EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH`;
- `ALL EVE_DEV_WORKFLOW_WORLD_ROUTE_PATH`;
- `ALL EVE_DEV_WORKFLOW_STREAM_ROUTE_PATH`;
- `POST EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN`;
- reservation-only `ALL EVE_PRODUCTION_CRON_ROUTE_PATTERN`.

The schedule/cron bridge and process-ready handshake remain typed host
capabilities; they are not fabricated as ordinary agent channel sources. Any
new host registration requires an inventory entry and collision coverage.
HTTP adapter availability derives from the effective compiled channel routes;
there is no synthetic adapter source slot or framework route catalog.

Production process startup waits for the non-HTTP ready handshake emitted
after the server listens. Development-server identity and reuse, including
Next.js, Nuxt, and SvelteKit adapter reuse, use the development
control/readiness transport plus recorded server identity. Remote clients, TUI
probes, and evals intentionally continue to observe the replaceable public
health contract through `Client.health()`.

### Persisted compiler diagnostics

Discovery, normalization, and route planning append to one persisted compiler
diagnostic union. Every source-specific locator carries its exact compiled
`nodeId`, plus `sourceId`, `logicalPath`, and optional physical `sourcePath`,
with at least one source locator required.
Once a candidate exists, its diagnostics use both `sourceId` and
`logicalPath`. Programmatic sources never fabricate a physical path.

The compiler keeps one diagnostic accumulator open until route planning is
complete. Route warnings therefore contribute to serialized diagnostics,
`diagnosticsSummary`, source-graph hashes, CLI rendering, and agent-info. A
shadow warning retains enough winner and loser identity to resolve its detailed
`CompiledShadowedChannelRoute`; the route plan remains authoritative. Compile
errors use the same stable codes and abort instead of being serialized into a
successful artifact. The diagnostic artifact moved to version 2 with the
framework-source graph and version 3 when node ownership became required. It
does not read either prior shape.

### Kernel capabilities

Native harness behavior cannot honestly be modeled as an ordinary executor
yet. Replace descriptive metadata plus scattered conditionals with typed
strategies or exhaustive switches. Fake resolved definitions and literal name
lists may not spread through graph, harness, prompt, dispatch, and inspection
code.

Each entry owns its canonical replacement path, reservation policy, node-level
preparation, node/session/turn/model scope, advertisement predicate,
materialization, runtime dispatch kind, prompt flags, and inspection
projection. Adding a capability name must produce TypeScript failures until
every lifecycle stage handles it. The closed inventory is:

| Capability                | Prepared from                                                     | Advertised to                       |
| ------------------------- | ----------------------------------------------------------------- | ----------------------------------- |
| `agent`                   | root node when `tools/agent.ts` is not replaced or disabled       | top-level root sessions             |
| `task_cancel`             | root tasks mode when `tools/task_cancel.ts` survives composition  | top-level root sessions             |
| `task_update`             | root tasks mode when `tools/task_update.ts` survives composition  | delegated task children             |
| `ask_question`            | `tools/ask_question.ts` is not replaced or disabled               | sessions supporting `requestInput`  |
| `load_skill` gating       | an effective compiled `load_skill` definition and loadable skills | sessions on that prepared node      |
| `web_search` materializer | the effective `tools/web_search.ts` provider sentinel             | model calls supporting its backend  |
| `Workflow`                | the compiled Workflow sentinel and eligible agent actions         | root sessions below the depth limit |
| `final_output`            | a turn requests structured final output                           | only the model call requiring it    |

Local and remote subagent tools remain derived from the effective subagent
graph. They are not kernel catalog entries, though the inventory may inspect
their runtime actions when preparing Workflow. No native capability may exist
outside this inventory, and no inventory entry may fabricate a `Resolved*`
record merely for validation or inspection.

Root tasks-mode preparation records whether the canonical `task_update` source
survived composition and propagates that prepared capability to every
task-owned session, including tasks targeting named or dynamic local
subagents. `task_cancel` remains restricted to eligible parent/root sessions.
The exhaustive lifecycle consumes this prepared source-backed state rather
than rediscovering task capability availability.

Preparation and advertisement are deliberately separate: a self-delegated or
task child can share the root node while receiving a different model-visible
tool set. Build inspection reports prepared potential, never claims to be the
exact tools for every session and model call.

Invariant guards reject native ordinary-resource fabrication and ad hoc kernel
capability registries outside the exhaustive integration points.

## Inspection v3

Replace agent-info v2 instead of preserving fields whose meanings no longer
fit. The `/eve/v1/info` payload becomes version 3 and has one projector from the
effective compiled graph, binding owners, composition diagnostics, and kernel
plan. All in-repository clients, TUI views, eval targeting, and tests migrate in
the same change; there is no v2 fallback before 1.0.

Version 3 reports:

- the selected default or authored agent config with its binding and owner;
- active static definitions in one list per primitive, each with its logical
  path, source ID, and owner (`application`, `extension`, or `framework`);
- active dynamic resolvers separately from their session-specific outputs,
  including exact subscribed events and explicit source provenance;
- prepared kernel capabilities separately from compiled tool definitions,
  including their audience/model conditions;
- the exact effective ordered channel-route list used by Nitro, including home
  and health, plus retained route-composition diagnostics;
- every compiled local subagent and its dynamic config resolver with explicit
  source ownership and `parentNodeId`;
- every declared remote agent in a separate `remoteAgents` collection with
  explicit provenance and `parentNodeId`, never folded into local subagent
  counts;
- composition diagnostic summaries for shadowed or disabled primitive and
  subagent candidates, never duplicate resource rows.

A dynamic model uses
`routing: { kind: "dynamic", resolver: AgentInfoDynamicResolverEntry }`.
A dynamic local subagent exposes
`configResolver?: AgentInfoDynamicResolverEntry`. These entries carry the
resolver source and exact events instead of adjacent optional fields. The root
agent exposes its compiled `nodeId`; local and remote collections are flat over
the complete graph, and every entry identifies its owning scope through
`parentNodeId`. Consumers traverse those opaque identities instead of parsing
them. Local subagents use `subagents: { local; total }`; remote agents use
`remoteAgents: { entries; total }` because they do not share local inheritance
or execution semantics.

It removes `available`, `authored`, `framework`, `disabledFramework`,
`replacesFramework*`, `disabledByAuthor`, and the
`active | disabled | opt-in | replaced` framework status taxonomy. Active
resources can be grouped by owner without duplicating them. Disabled and
shadowed candidates remain compiler composition diagnostics, not runtime
agent state.

Every inspectable source must have explicit ownership. Missing ownership is a
malformed artifact rejected at construction or load; agent-info never falls
back to application ownership, parses a source ID, or reconstructs an origin.
The kernel projection comes from the exhaustive inventory, and channel entries
come directly from `manifest.channelRoutes.effective`.

Normalizers continue recording safe facts that cannot be reconstructed from
serialized JSON, such as execution presence, approval, schemas, model-output
projection, adapter kind, and route identity. They never serialize callbacks.
Tool `hasAuth` remains false because arbitrary executor calls to `getToken()` or
`requireAuth()` cannot be inferred statically.

`eve info --json` and Vercel summaries keep their narrower contracts but use
the same effective compiled resources. They do not grow session-specific
dynamic outputs or pretend prepared kernel potential is a concrete model-call
tool set.

## In-memory compiler parity

The test-only in-memory compiler declares each programmatic application source
once. That registration derives its candidate, binding, manifest reference,
composition entry, and owner. It supplies complete bindings and composition to
the ordinary constructors, includes the framework default `agent.ts`, and
proves authored config replacement through the same phase-one composer.

Filesystem and memory fixtures must produce equivalent source owners, config
provenance, kernel plans, and module-map key sets. Cold-start namespace
reconstruction and durable callback replay use registry/module bindings only;
neither logical paths nor source IDs recover missing backing or provenance.

The app-harness execution helper accepts an installed tool identity or name and
resolves it from the compiled runtime bundle. It never builds a new registry
around a caller-owned `ResolvedToolDefinition`. Remove `createMemorySourceId`,
mirrored hand-built `AgentSourceManifest` references,
`applicationSourceOrigin`, and every test path that executes a caller-owned
definition instead of the selected installed tool.

## Downstream first-class memory integration gate

This proposal does not prove the first-class memory integration. Before memory
may depend on this mechanism, implementation must add a focused proof of this
entire path:

```text
authored memory slot
  -> compiled source binding
  -> deterministic programmatic wrapper namespace
  -> virtual tools/<slot>.ts exporting defineDynamic
  -> ordinary compiled dynamic resolver
  -> qualified provider tools
  -> cold-start namespace reconstruction and durable callback replay
```

The proof must use the same source graph and binding table, not a memory-only
registry or runtime contributor seam. It must show that a fresh process can
reconstruct the wrapper and resume a parked provider-tool call. This remains an
acceptance item for a future first-class memory implementation, not a
completion criterion for the canonical-source implementation. The complete
implementation still delivers the in-memory compiler parity described above.

## Delivery

The work lands through two PRs with one implementation boundary:

```text
#2404 research
  ↓
#2407 complete implementation and proof
```

#2407 owns the source-neutral bindings, canonical composition, framework and
extension migration, primitive ownership boundaries, default config source,
exhaustive kernel lifecycle, agent-info v3, in-memory compiler parity, docs,
e2e coverage, and rollout. It deletes every superseded path in the same PR;
there are no descendant implementation PRs or parallel delivery tracks to
restack.

Transitional helpers may exist while the implementation branch is under
construction, but no compatibility adapter lands. The implementation PR
includes one release-note-oriented changeset. Use `patch` for non-breaking
features and fixes and `minor` only for a breaking public API change. The
rollout updates tool, dynamic capability, config, channel, health, sandbox, and
agent-info documentation.

The research status remains `in-progress` until every deletion, validation
item, and required CI suite is complete.

## Version ledger

Compiled manifest versions record the implementation's serialized milestones
and are never reused after a rewrite:

| Serialized milestone            | Compiled manifest version | Serialized change                                                                                   |
| ------------------------------- | ------------------------: | --------------------------------------------------------------------------------------------------- |
| Source-neutral bindings         |                        45 | Required total bindings and semantic binding validation.                                            |
| Canonical composition           |                        46 | Required persisted composition and effective source-graph relationships.                            |
| Framework-source graph          |                        47 | Channel route plan, source records, programmatic revisions, and persisted diagnostic relationships. |
| Primitive ownership boundaries  |                        47 | No schema bump; this milestone only changes module ownership and imports.                           |
| Default config source           |                        48 | Required config binding, owner, and composition provenance.                                         |
| Exhaustive kernel lifecycle     |                        49 | Exhaustive serialized kernel capability plan.                                                       |
| Instrumentation source plan     |                        50 | Required source-backed instrumentation plan and immutable implementation identity.                  |
| External dependency closure     |                        51 | Required filesystem module dependency closure and exact package-instance identity.                  |
| Workflow world plan             |                        52 | Required world selection and exact materialized package backing.                                    |
| Agent-info v3 authority         |                        53 | Required normalized inspection metadata for tools, connections, hooks, and sandboxes.               |
| Remote config source graphs     |                        54 | Preserved each remote agent config's selected binding and composition in its own module scope.      |
| Canonical derived bindings      |                        55 | Removed duplicated instrumentation and external-entry identities in favor of authoritative plans.   |
| Compiler-scoped external plan   |                        55 | No schema bump; compilation finalizes its selected closures instead of resolving them again.        |
| Binding-scoped sandbox identity |                        56 | Optional module semantic revisions and selected-backing sandbox source identity.                    |
| Serialized workspace identity   |                        57 | Canonical workspace content hashes required for materialized managed resources.                     |
| Node scope and provenance       |                        58 | Root-only child-state rejection and retained source owner/backing relationships.                    |
| Workspace resource authority    |                        59 | Canonical per-node resource paths, derived root entries, and verified materialized byte identity.   |

Versions 42 through 44 and 60 were consumed by earlier implementation
iterations and are not reassigned. The exact projection and relational checks
prototyped at version 60 are folded into the earliest owning milestones above.

The compiler diagnostic artifact became version 2 with the framework-source
graph and version 3 when node-scoped locators became required. Disk and bundled
loaders reject earlier serialized shapes rather than repairing them. Any later
change to compiled serialization or relational invariants takes the next
unused manifest version; it may not reuse 45 through 60 even if an earlier
commit is rewritten.

## Distributed deletion ledger

The work is incomplete while any listed path or equivalent parallel system
remains:

| Requirement group            | Required deletion                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binding authority            | Optional bindings; binding reconstruction in compiled constructors; extension scope inferred from source-ID prefixes; fixtures that use physical extension paths as logical identity.                                                                                                                                                                                                                                                                                        |
| Composition and loading      | `logicalPath`-based module loading or sandbox hashing; post-normalization binding reconstruction; module normalizers accepting missing bindings; non-config definition loading before the total remaining binding table exists; eager programmatic namespaces or definition imports; `sourceComposition.sourceOwners` and duplicate active-owner indexes; arbitrary unbound injected definitions in production normalizers.                                                  |
| Framework-source graph       | Runtime no-source sandbox construction; `PACKAGE_ROUTES` and native home/health defaults; host lifecycle probes using the public health route; silent post-compile ordinary route drops; discovery-only diagnostics that lose compiler warnings; subagent origin `WeakMap` state and discarded subagent composition; prompt ownership parsed from source IDs; `public/tools/internal.ts` and `toPublicToolDefinition`; stale merge, disable, and fallback types or comments. |
| Primitive ownership          | The mixed `runtime/framework-tools` directory, transitional re-export wrappers, public-to-runtime imports, duplicate default definition values, and ordinary “framework tool catalog” terminology.                                                                                                                                                                                                                                                                           |
| Default config authority     | Synthesized default config in `normalize-agent-config.ts`, undefined-config-source inspection conventions, and config loading outside the total binding table.                                                                                                                                                                                                                                                                                                               |
| Kernel lifecycle             | Kernel lifecycle conditionals, literal name lists, or registries outside exhaustive integration points, plus native fabrication of ordinary resources.                                                                                                                                                                                                                                                                                                                       |
| Inspection and memory parity | Inspection owner fallback or framework-state reconstruction; omitted dynamic-resolver or remote-agent provenance; `createMemorySourceId`, mirrored memory manifest references, `applicationSourceOrigin`, and other in-memory descriptor shortcuts; harness execution of caller-owned tool objects; downstream source catalogs, composers, merges, or compatibility readers.                                                                                                 |
| External plan authority      | Per-module configured-package plan construction, final manifest re-resolution, hidden `__compile_loader__` owner scopes, and unversioned immutable package caches.                                                                                                                                                                                                                                                                                                           |

This ledger also removes the old framework tool and channel catalogs, duplicate
`Resolved*` constants and callback builders, `getAllFramework*Names`, compiled
or runtime `disabledFramework*` state, the connection-search history scanner
and synthetic registry, and the per-primitive extension prefix/rebase and
disable machinery. Helpers may move behind the canonical boundary, but a
renamed second source of truth does not satisfy deletion.

## Validation matrix

| Boundary                 | Required proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bindings and artifacts   | Missing, extra, path-mismatched, malformed extension, or missing-provenance bindings fail during construction and after disk or bundled schema parsing, before hydration. Opaque source IDs do not change loading or scope.                                                                                                                                                                                                                                                               |
| Selection and loading    | Every winner is bound before evaluation. Losing filesystem exports and programmatic namespace loaders never execute during compilation or cold start. Config derives later binding settings without loading non-config winners early.                                                                                                                                                                                                                                                     |
| Module-map parity        | Development, generated, materialized, bundled, hydrated, and in-memory maps expose the same `(nodeId, sourceId)` set and invoke only selected programmatic loaders. No virtual disk path is probed.                                                                                                                                                                                                                                                                                       |
| Identity and precedence  | Framework, extension-package, extension-override, and application candidates follow one slot precedence. Same-layer duplicates and flattened public tool-name collisions fail during compilation. Losing definitions are never normalized.                                                                                                                                                                                                                                                |
| Extensions and subagents | Projection qualifies each primitive once, preserves package backing and external dependencies, and retains ownership across nested and duplicate extension subagent mounts. No per-primitive merge or origin table remains.                                                                                                                                                                                                                                                               |
| Sandbox and config       | Default and authored sandboxes and configs each have one truthful selected source. Authored config shadows the lazy default, and filesystem and memory compilation report identical provenance.                                                                                                                                                                                                                                                                                           |
| External packages        | One compiler-scoped session selects configured package closures before definitions execute, records config-bootstrap witnesses, rejects owner conflicts or source mutation before later side effects, and finalizes those exact candidates into the manifest. Sandbox identity includes only its selected backing, relative closure, configured external closure, and programmatic revision. Immutable captures use the current versioned layout without trusting earlier cache topology. |
| Public home and health   | Replacement and disablement, `Client.health()` payload validation, `ClientError`, `HealthResponseError`, internal process readiness, adapter reuse, runtime dispatch, Nitro registration, and inspection agree without native fallback.                                                                                                                                                                                                                                                   |
| Route planning           | Cross-channel selection is deterministic and shared by dispatch, WebSocket handling, CORS, Nitro, and inspection. Same-source duplicates, reserved host overlaps, parameter-equivalent patterns, explicit `OPTIONS` conflicts, and inconsistent CORS use their stable compile errors.                                                                                                                                                                                                     |
| Diagnostics              | Route warnings retain exact winner/loser provenance and survive disk and bundled loading, summaries, hashes, CLI rendering, and agent-info without requiring a physical path.                                                                                                                                                                                                                                                                                                             |
| Framework behavior       | Connection search preserves filtering, auth, approval, failure, long-name, durable callback, and restart behavior without history scanning. Load skill, web search, ordinary defaults, callbacks, and extension overrides retain their public behavior.                                                                                                                                                                                                                                   |
| Kernel lifecycle         | Every capability is covered through preparation, advertisement, materialization, dispatch, prompts, and inspection for root, self-delegated root, named and dynamic task children, non-task children, provider-dependent calls, Workflow depth, and structured output. Named task children receive `task_update`.                                                                                                                                                                         |
| Inspection               | `AgentInfoResultSchema` validates exact unique sets and counts for config, primitives, effective and shadowed routes, dynamic resolver events, local subagents, remote agents, owners, composition, and kernel potential. Nitro's ordinary routes equal agent-info channels.                                                                                                                                                                                                              |
| In-memory execution      | Each memory source is declared once. Filesystem and memory fixtures produce the same owner graph and kernel plan. The harness resolves and executes the installed compiled tool rather than an imported definition object.                                                                                                                                                                                                                                                                |
| End to end               | A deterministic fixture covers defaults, extension and override layers, application replacement and disablement, nested subagents, `task_update`, home/health, dynamic tools and skills, dynamic model and subagent config, a remote agent, sandbox, and default/authored config across development, production, and agent-info artifacts. It invokes a replaced ordinary tool through the installed runtime rather than an imported definition object.                                   |

Run inexpensive checks throughout implementation:

```sh
pnpm fmt
pnpm lint
pnpm typecheck
pnpm guard:invariants
pnpm test:unit
```

Run the narrowest relevant integration and scenario files while iterating. The
complete implementation also runs:

```sh
pnpm build
pnpm test:integration
pnpm test:scenario
pnpm test:tui
pnpm docs:check
```

Fixture-owned e2e suites run in CI. The final required CI includes deterministic
world suites and the real-model `e2e-local` aggregate. Transport or provider
variance may be rerun, but repeated failures are investigated rather than
waived.

## Completion criteria

The implementation is complete only when:

1. A compiled artifact with missing binding, owner, composition, or route
   provenance cannot be constructed or loaded.
2. Removing a selected framework source removes its runtime behavior; no
   runtime layer recreates it.
3. Every active ordinary capability appears once by public identity in the
   compiled graph and once in inspection. Named primitives use their runtime
   name; routes use method plus normalized path pattern.
4. Nitro registers no ordinary route or generated preflight absent from the
   compiled channel route plan.
5. Every model-visible native kernel capability and every non-source host
   registration is named in its exhaustive closed inventory.
6. Agent-info explains the owner and replacement history of every config,
   primitive, route, local subagent, remote agent, and dynamic resolver without
   parsing identifiers.
7. Searches for the distributed deletion ledger return no production match or
   renamed equivalent.
8. The complete implementation lands in #2407, and all required local and CI
   validation passes.
9. Changing a selected filesystem module or programmatic executable revision
   changes module-map identity, while relocating identical filesystem content
   without changing its logical extension namespace does not.

## Invariants and rejected alternatives

- Logical paths remain eve's only definition naming grammar. Backing, owner,
  and source ID never change normalization semantics.
- One candidate composer chooses before definition execution. There is no
  per-primitive precedence, disable implementation, or separate subagent
  composer.
- Required compiled bindings are the only authority for namespace loading.
  Optional metadata, inferred physical paths, and virtual disk fallback cannot
  affect behavior.
- Programmatic construction is explicit, immutable, statically reachable, and
  lazy. There is no global registry, runtime graph mutation, function
  serialization, generated temporary source, or unselected namespace
  evaluation. Every binding pins the registered source revision and rejects a
  different implementation before load.
- Active ownership has one location. Composition entries own only losing or
  disabled provenance; no winner-owner index or origin table is retained.
- `defineDynamic` remains the sole dynamic-definition lifecycle. Framework and
  future memory features do not gain parallel validation, durability,
  replacement, collision, or callback stores.
- Ordinary route dispatch comes only from the compiled route plan. Native
  behavior is limited to the separate exhaustive kernel and host inventories;
  a universal native-tool, route, or adapter escape hatch is rejected.
- Pre-1.0 cleanup is a breaking replacement: no legacy manifest reader,
  agent-info schema, health fallback, history reconstruction, duplicate status
  state, or compatibility path is retained.
