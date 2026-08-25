---
issue: https://github.com/vercel/eve/issues/2347
status: in-progress
last_updated: "2026-08-25"
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
`defineAgent`, `defineInstrumentation`, and the existing connection, hook,
schedule, instruction, and skill factories. They never construct `Compiled*` or `Resolved*` records.
Production runtime behavior continues to live in the `eve` package; generated
module maps only bind statically reachable module namespaces.

The compiled manifest, required bindings, persisted composition report,
compiler-owned channel route plan, and closed kernel effect and host
capability plans are the only downstream authority. An active module-backed
source is owned by its binding. An active non-module source is owned by its
explicit compiled source record. A losing or disabled source is owned by its
self-contained composition entry. No second winner-owner index or out-of-band
origin table may exist.

Every ordinary framework default is a first-class eve primitive at a canonical
logical path, including the default `agent.ts`, sandbox, home page, and the
eve channel carrying the public health and info endpoints. Native execution
may implement a selected primitive, but it may not create that primitive's
presence independently of the source graph.
Model-visible kernel behavior is keyed by a closed set of typed effect kinds —
never by tool name — and host registrations that cannot be ordinary sources
live in a separate, typed, exhaustive inventory.

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
- the home page, public health endpoint, and `/eve/v1/info` inspection
  endpoint are native host routes that bypass channel source composition and
  use a second route-precedence system;
- subagent composition results from `composeAgentSubagentSources` and
  `composeExtensionSubagentSources` are consumed inline and discarded, while
  module-global `WeakSet`/`WeakMap` state stands in for compiled subagent
  identity at runtime;
- two agent-info builders re-create framework status from different inputs;
- native harness tools are represented by metadata stubs that are not the
  definitions the harness advertises or executes.

Native dispatch itself is a layer of magic strings. Execution branches on
`sourceId.startsWith("eve:")` to decide how a tool executor is called; the
harness recognizes `ask_question` and `final_output` by tool-name comparison;
task control is classified through the `TASK_TOOL_NAMES` name set;
`load_skill` carries a `frameworkAction` marker even though it runs an
ordinary inline executor; and advertisement rules such as root-only and
delegated-caller-only visibility are name checks inside the harness.

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
- migrate ordinary and effectful framework tools, `connection_search`, the
  eve channel (carrying the callbacks, health, and info), the home channel,
  the default sandbox, and the default `agent.ts` to programmatic eve
  modules;
- separate public primitive definitions, execution implementations, and native
  kernel code so each ordinary default has one definition value;
- replace scattered native-tool knowledge — name checks, source-ID prefixes,
  and marker fields — with a closed inventory of typed kernel effect kinds
  covering preparation, advertisement, materialization, dispatch, prompt
  flags, and inspection;
- limit non-source host behavior to an explicit closed host inventory and move
  process readiness away from the replaceable public health route;
- replace agent-info v2 with a truthful v3 projection;
- remove each superseded framework, extension-composition, fallback, and
  inspection path in the delivery PR that supersedes it.

The implementation does not expose a public registration API or public effect
constructors, serialize functions, mutate a compiled graph, create
programmatic subagent nodes, or virtualize markdown and skill asset files.
Programmatic modules may be applied to already-discovered local nodes. The
framework registry receives a narrow exception to provide the default config
slot, but no registration may recursively introduce nodes, extensions, or raw
workspace content.

## Source model

### Programmatic modules

Programmatic sources declare immutable, lazily loaded module namespaces at
virtual agent-relative paths:

```ts
type ProgrammaticModuleNamespace = Readonly<Record<string, unknown>>;

interface ProgrammaticModuleLoadContext {
  readonly dependencies: Readonly<Record<string, ProgrammaticModuleNamespace>>;
  readonly parameters: JsonObject;
}

interface ProgrammaticAgentModule {
  readonly exportName?: string;
  readonly loadNamespace: (
    context: ProgrammaticModuleLoadContext,
  ) => Promise<ProgrammaticModuleNamespace>;
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

interface AgentSourceRegistryOptions {
  readonly templates?: readonly ProgrammaticAgentSource[];
}

function createAgentSourceRegistry(
  registrations: readonly AgentSourceRegistration[],
  options?: AgentSourceRegistryOptions,
): AgentSourceRegistry;
```

`logicalPath` is a normalized POSIX path relative to an agent root. It must
match the existing grammar, cannot be absolute or traverse with `..`, and may
select only module-backed slots. The path derives identity; there is no `name`,
slug, kind, protocol, or precedence field.

The selected export follows existing ESM semantics and may be a zero-argument
sync or async factory. A namespace loader may ignore its context when it is an
ordinary overlay; a derived module receives selected dependency namespaces and
serialized parameters through that context. Construction shallow-copies and
freezes source and module data without invoking `loadNamespace`. The loader
returns the exact namespace and preserves brands, symbols, functions, and
durable callback metadata. Programmatic source IDs derive deterministically as
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
compilation. Registrations are source overlays; templates are loadable module
implementations used only by derived candidates and never inject candidates on
their own. Registries are not global, side-effect-populated, or mutable at
runtime. `root` applies only to the application root. `all-local-nodes` is a
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

type AgentSourceForm = "derived" | "authored";

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
        readonly dependencies?: Readonly<Record<string, string>>;
        readonly kind: "programmatic";
        readonly moduleId: string;
        readonly parameters?: JsonObject;
        readonly registryId: string;
        readonly revision: string;
        readonly semanticRevision?: string;
      };
  readonly form: AgentSourceForm;
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

### Derived slot composition

A selected module may induce an ordinary candidate in another logical slot by
instantiating a registered programmatic template:

```text
selected memory/profile.ts ──dependency "memory"──> derived tools/profile.ts
                                                        │
                                     ordinary slot composition and binding
```

`createDerivedProgrammaticModuleCandidate` records dependency aliases as
selected source IDs and behavior-critical JSON `parameters` in the
programmatic backing. It does not evaluate either module. Dependencies must
belong to the same node and remain selected after composition; an authored
candidate wins over a derived candidate within the same source layer. Normal
cross-layer precedence still applies, so an application-derived capability can
replace an extension contribution while an application-authored source can
replace or disable the derived capability.

Templates are not an open projection callback or a mutable registry. A closed
compiler feature decides when to instantiate one from the already-discovered
source graph, then the ordinary composer, binding table, normalizers, and
module maps take over. Compiled dependency graphs reject missing bindings and
cycles. Compilation, in-memory hydration, and generated module maps resolve
dependencies in order and cache each selected namespace once per phase.

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
module-map hydration. That validator is one module: new artifact checks
extend it, and sibling per-artifact validator files are a design failure, not
a pattern.

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

### Binding-safe compilation

Two invariants order compilation, because build settings derive from the
selected config:

- The config slot composes and binds first, and the winning `agent.ts` loads
  before any non-config definition. Build, task, and external-dependency
  settings derive from that selected config.
- Losing candidates never receive bindings and never execute — not during
  compilation, and not during cold-start hydration.

The config normalizer receives only its selected candidate and required
binding. Module-backed primitive normalizers require a binding. Direct
injected definitions are not a production escape hatch: no candidate
constructor accepts an evaluated definition value, and the only
already-evaluated value passed between compilation phases is the
compiler-owned selected config.

The two phases append candidates to one composition state. There is no
partial-graph merge step, no post-hoc disjointness or integrity assertion,
and no string phase discriminator — phase safety is a type, such as a
phase-one state that cannot yet yield a manifest.

`createProgrammaticCompiledModuleMap` is asynchronous and resolves only the
programmatic bindings present in the compiled manifest. Generated,
materialized, bundled, hydrated, and in-memory maps await those same selected
loaders and expose the same `(nodeId, sourceId)` set.

## One composition pass

The composer operates on canonical logical slots before loading or normalizing
definitions. Precedence is:

```text
framework default < extension package < extension override < application
derived < authored within one layer
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
exists. Parallel owner indexes such as a `sourceComposition.sourceOwners` map
or full duplicate winner descriptors are forbidden.

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
mounting one extension twice cannot share provenance. The inline
`composeAgentSubagentSources` and `composeExtensionSubagentSources` composers
whose results are discarded, the module-global subagent executor-identity
state, and any out-of-band subagent origin table are removed. Shadowed and
supported disabled subagent candidates remain self-contained composition
entries for diagnostics and inspection.

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
prepared kernel effect plan. Those are the only named plan artifacts.
Instrumentation, the Workflow world, sandbox workspace assets, and external
dependencies are per-binding data, ordinary slot content, or existing config —
introducing any new named plan artifact requires amending this document
first. Every downstream consumer reads the effective graph:

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

### Default source inventory

After migration, the framework provides exactly these default identities
through source composition:

| Identity                     | Definition                             | Registered for   | Notes                                                                 |
| ---------------------------- | -------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| `agent.ts`                   | `defineAgent`                          | every local node | default model config; phase-one composition                           |
| `sandbox.ts`                 | `defineSandbox({})`                    | every local node | selects `defaultSandbox()`; stable semantic revision                  |
| `tools/bash.ts`              | `defineTool`                           | every local node | ordinary executor                                                     |
| `tools/read_file.ts`         | `defineTool`                           | every local node | ordinary executor                                                     |
| `tools/write_file.ts`        | `defineTool`                           | every local node | ordinary executor                                                     |
| `tools/todo.ts`              | `defineTool`                           | every local node | ordinary executor                                                     |
| `tools/web_fetch.ts`         | `defineTool`                           | every local node | ordinary executor                                                     |
| `tools/load_skill.ts`        | `defineTool`                           | every local node | visibility: `requires-loadable-skill`                                 |
| `tools/connection_search.ts` | `defineDynamic`                        | every local node | discovers and qualifies connection tools                              |
| `tools/ask_question.ts`      | `defineTool` + `request-input`         | every local node | visibility: `requires-request-input`                                  |
| `tools/agent.ts`             | `defineTool` + `dispatch`              | root node        | action: `subagent-call`; visibility: `root-session`                   |
| `tools/task_update.ts`       | `defineTool` + `dispatch`              | root node        | action: `task-update`; tasks mode; visibility: `delegated-task-child` |
| `tools/task_cancel.ts`       | `defineTool` + `dispatch`              | root node        | action: `task-cancel`; tasks mode; visibility: `root-session`         |
| `tools/web_search.ts`        | `webSearch` sentinel + `provider-tool` | every local node | materialized at eligible model calls                                  |
| `channels/eve.ts`            | `eveChannel` factory                   | root node        | complete `/eve/v1` surface: protocol, callbacks, health, info         |
| `channels/home.ts`           | `defineChannel`                        | root node        | `GET` and `HEAD` at `/`                                               |

Every identity above is replaceable and disableable through ordinary slot
composition. `glob` and `grep` are published at `eve/tools/glob` and
`eve/tools/grep` but never registered. Workflow shares the slot pattern
without a framework default: an authored `experimental_workflow()` sentinel
at `tools/workflow.ts` opts in at that canonical identity. Authored
`instrumentation.ts` likewise composes as an ordinary module slot with no
framework default and no dedicated plan artifact. Native behavior outside
these identities is limited to `final_output` and the closed host inventory.

### Primitive ownership boundaries

Ordinary public definitions and schemas live under `public/tools` or another
primitive-owned shared module. Execution-only implementations and durable
state live under `execution/tools` or an equivalent execution-owned boundary.
Kernel effect handlers live under `kernel/<effect>` or their effect-specific
execution modules.

Each ordinary default has exactly one definition value. Its framework source
module and its public `eve/tools/<name>` subpath export import that same
value; there is no barrel export. Moving modules must
preserve durable state key identity for todo, read-before-write, skill,
connection-search, compaction, and task behavior. These boundaries hold
structurally: public modules do not import `runtime/`, ordinary framework
sources construct only public definitions, and kernel effects are dispatched
only through the closed effect inventory.

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
or other recursive graph content. That exception is safe because config
composes in the first phase against already-discovered nodes: the registration
can never introduce a node, so it cannot expand the graph it composes into.
Remove the synthesized `{ model: DEFAULT_AGENT_MODEL_ID }` normalizer branch,
undefined-config-source inspection conventions, and config loading that
bypasses the total binding table.

### Ordinary tools

Author `bash`, `read_file`, `write_file`, `todo`, `web_fetch`, and
`load_skill` once as public `defineTool` values with plain executors. Register
those exact values at canonical paths and publish each at its own
`eve/tools/<name>` subpath. The `eve/tools/defaults` barrel export is
deleted. `glob` and `grep` are published the same way at `eve/tools/glob` and
`eve/tools/grep` but are never registered as defaults.

Their executors receive ordinary `ToolContext`. Remove the public/internal
converter, duplicate resolved-definition constants and wrappers, and the
`sourceId.startsWith("eve:")` calling convention. Framework ownership comes
from the binding, not a string prefix.

`load_skill` already has a real executor today; its
`frameworkAction: "load-skill"` classification marker is deleted. Its executor
reads an eve-owned skill-catalog context provider instead of closing over
resolved skills, and its advertisement gate — whether the node can load a
static or dynamic skill — becomes declared visibility data rather than a
fabricated second definition. Dynamic-skill and cold-start behavior use the
same compiled source and selected binding; no special source type or native
fallback remains.

### Effectful tools

`ask_question`, `agent`, `task_update`, and `task_cancel` are ordinary public
`defineTool` values, and `web_search` is the public `webSearch()` sentinel,
all registered at canonical `tools/*.ts` slots. They compose, replace, and
disable through the same source graph as any authored tool. Instead of an
executor that performs work in-process, each declares a typed kernel effect
(described below). The definitions know nothing about Workflow, parking,
pending batches, or the model SDK; the kernel translates a declared effect
into durable park/resume mechanics.

The declaration and its visibility conditions are closed, JSON-serializable
data carried on the definition value:

```ts
interface KernelEffectDeclaration {
  readonly kind: "request-input" | "dispatch" | "provider-tool";
  // per-kind payload stays minimal and JSON-serializable;
  // "dispatch" carries one typed action
}

type DispatchAction =
  | { readonly kind: "subagent-call"; readonly nodeId: string; readonly subagentName?: string }
  | { readonly kind: "remote-agent-call"; readonly nodeId: string }
  | { readonly kind: "task-update" }
  | { readonly kind: "task-cancel" };

type ToolVisibilityCondition =
  | "root-session"
  | "delegated-task-child"
  | "requires-request-input"
  | "requires-loadable-skill"
  | "below-subagent-depth";
```

A definition declares zero or more visibility conditions; all declared
conditions must hold for a session or model call to advertise the tool, and
the kernel evaluates them without reading the tool's name. Visibility follows
the same public-shaped, internally constructed rule as effect declarations:
the types live on public definitions, the constructors stay unexported.

An application `defineTool(...)` or `disableTool()` at any of those identities
composes normally. Replacing `tools/web_search.ts` with an application
`webSearch(...)` or ordinary tool follows the same rule; model/provider
materialization remains the `provider-tool` effect described below.

Workflow follows the same pattern with no framework default: the authored
`experimental_workflow()` sentinel at `tools/workflow.ts` composes at that
canonical slot and carries the tool's complete configuration in its
arguments. It mints no new effect kind — the sentinel declares `dispatch` in
program mode, which is code mode over the same effect. The kernel
materializes the model-visible tool as an isolated program sandbox whose
only host functions are the other `dispatch`-declaring tools in the
effective graph. Each host call performs the same `dispatch` effect the
`agent` tool performs, restricted to the agent-call actions — a program
performing a task action is rejected — with results resuming the durable
program instead of the model step. Advertisement (root sessions below the
depth limit) is declared visibility data like any other effectful tool.
Despite the shared name, `defineAgent({ experimental: { workflow } })` is
unrelated to the tool: it selects the durable-runtime world backing the
agent's own execution. That world selection and the workflow transport in
the closed host inventory are not tool identities.

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
The channel value owns the complete `/eve/v1` surface as ordinary channel
routes: the session protocol, the connection callbacks (GET and POST plus
their legacy forms), the workflow callback, task input, the public health
protocol at `/eve/v1/health`, and the agent-info route at `/eve/v1/info`.
There is exactly one framework identity for that surface; no framework
channel registers at a deeper logical path.

URLs, legacy support, authorization, status codes, and response bodies do not
change. Route definitions carry per-route authorization so current behavior
survives inside one channel: health stays publicly reachable while info, the
callbacks, and the protocol routes keep the resolved channel auth policy. The
definitions carry truthful HTTP adapter metadata and use the ordinary channel
handler path, eliminating framework-only route construction and fetch
dispatch. Data needed by the info handler comes from an eve-owned context
provider — the effective compiled graph, binding owners, composition
diagnostics, and kernel plan — not a special source kind or build-time native
route.

Add a root framework channel module at `channels/home.ts` using ordinary
`defineChannel`, `GET`, and `HEAD` values for the home page at `/`. Its
metadata also comes from an eve-owned context provider, and the default
preserves the current response body, status codes, and authentication
behavior.

The eve channel and home compose as two slots. An authored `channels/eve.ts`
— typically another `eveChannel(...)` call with different auth — replaces the
complete default surface, and a disable sentinel removes it; health, info,
and the callbacks are not independently replaceable. This is an intentional
pre-1.0 breaking change. A replacement owns its implementation, but the
public payload contracts remain client-enforced: `Client.health()` validates
successful JSON with `HealthResultSchema` — a non-success response throws
`ClientError` and an invalid successful payload throws `HealthResponseError`
— and `Client.info()` validates with `AgentInfoResultSchema` and throws
`AgentInfoResponseError` for an unusable authorized payload. No client or
host code reaches a hidden native fallback.

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

Replacing or disabling `channels/home.ts` or `channels/eve.ts` is source-slot
composition. An unrelated channel that declares the same concrete route
follows route ordering and does not gain source precedence.

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
successful artifact. The discovery-diagnostics artifact (version 1 today)
becomes this compiler diagnostic artifact at version 2; loaders reject the
earlier serialized shape rather than repairing it.

### Kernel effects

Some framework tools cannot be modeled as plain executors: their behavior is
to durably suspend the turn workflow and resume it with an externally produced
result. Main already proves the mechanics — an authored tool with `approval`
parks the entire durable turn through the pending-input path, and
`requireAuth()` raises a typed signal the harness converts into an
authorization park. What is missing is a typed boundary: today the harness
recognizes these tools by name strings, source-ID prefixes, and marker fields.

Both names are load-bearing. The kernel is eve's privileged core in the
operating-system sense: definitions cannot suspend or resume the durable
workflow themselves, only kernel handlers touch park/resume state, and the
closed effect inventory plays the role of a syscall table. `request-input`
suspends a turn the way a blocking `read()` suspends a process, and the
kernel later resumes it with the result. Effects take their name from
algebraic effects and handlers in programming-language theory: a definition
performs an operation it cannot interpret, and a handler — here, the
kernel — suspends the computation and resumes it with a value. The durable
callback pattern, a stable identity plus a JSON closure rebound to live code
on every run, is that suspended computation's serialized continuation.

The kernel is keyed by a closed set of effect kinds, never by tool name:

| Effect kind     | Declared by                                                                                                                                                      | Kernel behavior                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `request-input` | `tools/ask_question.ts`; tool approvals internally                                                                                                               | park the turn on a pending input batch; resume synthesizes the tool result    |
| `dispatch`      | `tools/agent.ts`; graph-derived subagent and remote-agent tools; `tools/task_update.ts`; `tools/task_cancel.ts`; the `tools/workflow.ts` sentinel (program mode) | park; execute typed actions in the durable dispatch step; resume with results |
| `provider-tool` | the `tools/web_search.ts` provider sentinel                                                                                                                      | materialize the provider-managed tool at eligible model calls; no suspension  |

The two suspension kinds are genuinely distinct — `request-input` resolves
inside the harness when the next channel delivery arrives, while `dispatch`
resolves outside it in a durable step — and `provider-tool` never suspends at
all. Everything narrower is payload, not a new kind. A `dispatch`
declaration either names exactly one typed `DispatchAction` (call mode) or
declares program mode, where the materialized durable program performs
agent-call actions. The dispatch handler switches exhaustively over the
action union: `subagent-call` and `remote-agent-call` start or resume child
sessions; `task-update` and `task-cancel` execute task commands and may not
be performed from a program. Results resume one of two continuations the
pending batch already identifies: the model step, or the durable Workflow
program whose host call performed the effect.

Each effect kind owns its park semantics, dispatch, resume, prompt flags,
advertisement predicate evaluation, and inspection projection through one
exhaustive lifecycle. Adding an effect kind — or a dispatch action kind —
must produce TypeScript failures until every lifecycle stage handles it.
Effects prepare from the effective composed sources that declare them:
replacing or disabling `tools/agent.ts` removes its `dispatch` preparation
because no selected definition declares the effect. The compiled kernel
effect plan serializes, per node, each prepared effect kind with its
declaring source ID, action kind where applicable, and declared visibility
conditions — nothing more. No kernel code fabricates a `Resolved*` record
merely for validation or inspection.

Effect declarations are public-shaped but internally constructed: the types
live on the tool definition, not in harness code, and carry no reference to
Workflow or execution internals. The constructors remain unexported; opening
them to application tools is a separate future proposal. Effect resume state
persists through the same durable callback pattern `defineDynamic` already
uses; effects gain no parallel continuation store.

`final_output` is the sole remaining non-tool native. It is injected per model
call only when a turn requires structured output, its input schema is that
turn's output schema, and calling it terminally intercepts the turn. It has no
honest static source slot, so it stays outside the source graph as an
explicitly typed terminal-output interception in the kernel.

Preparation and advertisement are deliberately separate: a self-delegated or
task child can share the root node while receiving a different model-visible
tool set. Root tasks-mode preparation records whether the canonical
`task_update` source survived composition and propagates that prepared
capability to every task-owned session, including tasks targeting named or
dynamic local subagents; `task_cancel` remains restricted to eligible
parent/root sessions. Build inspection reports prepared potential, never
claims to be the exact tools for every session and model call.

Local and remote subagent tools remain derived from the effective subagent
graph; they declare the `dispatch` effect rather than appearing as kernel
catalog entries. Workflow's sandbox materialization derives its host
functions from exactly those `dispatch`-declaring tools.

The layering is structural, not tooled: no harness or execution code may
branch on a tool name or source ID; only kernel effect handlers touch
park/resume session-state keys; `public/` modules never import `runtime/`,
`harness/`, or `execution/`; and the kernel exposes no lookup by tool name or
logical path — consumers receive prepared effect state instead of querying
the inventory. Native ordinary-resource fabrication or effect dispatch
outside the exhaustive integration points is a design error to correct in
the implementation, not a condition to police with new guards.

This deletes the magic-string dispatch layer: `sourceId.startsWith("eve:")`
execution branching, `toolName === "ask_question"` and
`toolName === "final_output"` harness checks, the `TASK_TOOL_NAMES`
name set, the `frameworkAction: "load-skill"` marker, and name-based
visibility rules in tool advertisement.

## Inspection v3

Replace agent-info v2 instead of preserving fields whose meanings no longer
fit. The `/eve/v1/info` payload becomes version 3 and has one projector from the
effective compiled graph, binding owners, composition diagnostics, and kernel
plan, served as an ordinary route of the framework eve channel at
`channels/eve.ts` rather than a native Nitro route. All in-repository
clients, TUI views, eval targeting, and tests migrate in the same change;
there is no v2 fallback before 1.0.

Version 3 reports:

- the selected default or authored agent config with its binding and owner;
- active static definitions in one list per primitive, each with its logical
  path, source ID, and owner (`application`, `extension`, or `framework`);
- active dynamic resolvers separately from their session-specific outputs,
  including exact subscribed events and explicit source provenance;
- prepared kernel effects separately from compiled tool definitions,
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
The kernel projection comes from the exhaustive effect inventory, and channel
entries come directly from `manifest.channelRoutes.effective`.

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
mirrored hand-built `AgentSourceManifest` references, and every test path that
executes a caller-owned definition instead of the selected installed tool.

## Downstream memory integration

The wrapper-namespace path uses derived slot composition: a selected authored
memory slot instantiates a registered template whose virtual
`tools/<slot>.ts` exports `defineDynamic`, depends on the selected memory
binding, and carries the slot as serialized parameters. The result is an
ordinary compiled resolver producing qualified provider tools. The memory
implementation must prove cold-start namespace reconstruction and resuming a
parked provider-tool call through this source graph and binding table rather
than a memory-only registry or runtime contributor seam.

## Delivery

The implementation lands as two stacked PRs split at the boundary between
source identity and dispatch behavior. Each PR deletes every path it
supersedes; no compatibility adapter lands in either. The split isolates the
two failure domains: PR 1's risk is compilation, serialization, and loading,
guarded by artifact validators and module-map parity; PR 2's risk is
park/resume semantics inside the harness, reviewed in a small focused diff.
PR #2407 was an earlier atomic attempt at this boundary; it remains open only
as salvage reference and does not gate or define the implementation.

Both PRs are judged by replacement ratio: production deletions from the
ledger meet or exceed new machinery, and the touched subsystems end
materially simpler than they started. A growing `guard-invariants` script,
sibling validator modules, new plan artifacts, or hand-built test factories
signal that the design is failing — the correction is always in the
implementation, never in tooling around it. `guard-invariants` gains no new
rules for this work; its changes are limited to baseline shrinks and
deleted-path references.

### PR 1 — canonical source graph

Everything becomes a source, and dispatch behavior does not change:

1. source-neutral candidates, required bindings, and the one composition pass;
2. ordinary framework tool, config, sandbox, and `connection_search`
   migration to programmatic sources;
3. effectful tool definitions registered at their canonical `tools/*.ts`
   slots — presence, replacement, disablement, and ownership become source
   composition, while the harness continues to supply their behavior through
   the existing dispatch mechanics;
4. framework channels, the compiled route plan, and the closed host inventory;
5. inspection v3 and in-memory compiler parity.

`COMPILED_AGENT_MANIFEST_VERSION` moves from 41 to 42 with required total
bindings, persisted composition, the channel route plan, config provenance,
and v3 inspection metadata. The compiler diagnostic artifact moves from
version 1 to version 2 in the same PR. Disk and bundled loaders reject
earlier serialized shapes rather than repairing them. The complete version 42
schema, its single semantic validator, and serialization fixtures land first
inside the PR, and the serialized shape does not change again within it. Kernel preparation
switches from catalog membership to slot survival: a capability prepares only
when its canonical source survived composition, and agent-info v3 derives its
prepared kernel entries from that survival plus the static kind mapping.

PR 1 carries one explicitly inventoried transitional seam: the harness still
recognizes `ask_question`, `agent`, `task_update`, `task_cancel`,
`web_search`, and `final_output` through today's name checks, `runtimeAction`
markers, and the `frameworkAction: "load-skill"` marker. Nothing else on the
magic-string list survives PR 1 — the `sourceId.startsWith("eve:")` calling
convention dies with the catalog — and no new name-based dispatch may be
added.

PR 1 includes the `minor` changeset — it breaks the agent-info schema, moves
the health and info routes into the replaceable eve channel, and replaces the
`eve/tools/defaults` barrel with per-tool `eve/tools/<name>` subpath exports —
and updates tool, config, channel, health, sandbox, and agent-info
documentation.

### Follow-up — derived slot composition

Programmatic templates, derived-vs-authored precedence within a layer, binding
dependencies, serialized parameters, and dependency-aware namespace loading
land as one focused source-graph extension before memory builds on the graph.
`COMPILED_AGENT_MANIFEST_VERSION` moves from 42 to 43. This follow-up carries a
`patch` changeset because it changes only internal compiler capabilities.

### PR 2 — kernel effects

Dispatch becomes declared effects, and the seam is deleted:

1. effect declarations and visibility conditions consumed by the kernel;
2. the exhaustive effect-kind lifecycle, with approvals riding
   `request-input`;
3. replacement of `localSubagentExecutors` function-identity classification
   with prepared `dispatch` effect state;
4. deletion of the complete magic-string dispatch layer listed in the
   deletion ledger's kernel row.

`COMPILED_AGENT_MANIFEST_VERSION` moves from 43 to 44 with the serialized
kernel effect plan. PR 2 is `patch` when externally observable behavior is
preserved, and updates the dynamic capability documentation.

PR 2 depends entirely on PR 1 and starts only after it lands; nothing in PR 1
depends on PR 2. When PR 2 lands, #2347 is closed with a pointer to this doc.
The research status remains `in-progress` until every deletion, validation
item, and required CI suite across both PRs is complete.

## Distributed deletion ledger

The work is incomplete while any listed path or equivalent parallel system
remains:

| Requirement group            | Required deletion                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binding authority            | Optional bindings; binding reconstruction in compiled constructors; extension scope inferred from source-ID prefixes; fixtures that use physical extension paths as logical identity.                                                                                                                                                                                                                                                                      |
| Composition and loading      | `logicalPath`-based module loading or sandbox hashing; post-normalization binding reconstruction; module normalizers accepting missing bindings; non-config definition loading before the total remaining binding table exists; eager programmatic namespaces or definition imports; parallel active-owner indexes; arbitrary unbound injected definitions in production normalizers.                                                                      |
| Framework-source graph       | Runtime no-source sandbox construction; `PACKAGE_ROUTES` and the native home, health, and info route defaults; host lifecycle probes using the public health route; silent post-compile ordinary route drops; discovery-only diagnostics that lose compiler warnings; module-global subagent executor-identity state and discarded subagent composition; prompt ownership parsed from source IDs; `public/tools/internal.ts` and `toPublicToolDefinition`. |
| Primitive ownership          | The mixed `runtime/framework-tools` directory, the `eve/tools/defaults` barrel export, transitional re-export wrappers, public-to-runtime imports, duplicate default definition values, and ordinary “framework tool catalog” terminology.                                                                                                                                                                                                                 |
| Default config authority     | Synthesized default config in `normalize-agent-config.ts`, undefined-config-source inspection conventions, and config loading outside the total binding table.                                                                                                                                                                                                                                                                                             |
| Kernel effects               | `sourceId.startsWith("eve:")` execution branching; `ask_question` and `final_output` tool-name checks in the harness; the `TASK_TOOL_NAMES` name set; the `frameworkAction: "load-skill"` marker; name-based advertisement visibility; kernel conditionals, literal name lists, or registries outside the exhaustive integration points; native fabrication of ordinary resources.                                                                         |
| Inspection and memory parity | Inspection owner fallback or framework-state reconstruction; omitted dynamic-resolver or remote-agent provenance; `createMemorySourceId`, mirrored memory manifest references, and other in-memory descriptor shortcuts; harness execution of caller-owned tool objects; downstream source catalogs, composers, merges, or compatibility readers.                                                                                                          |

This ledger also removes the old framework tool and channel catalogs, duplicate
`Resolved*` constants and callback builders, `getAllFramework*Names`, compiled
or runtime `disabledFramework*` state, the connection-search history scanner
and synthetic registry, and the per-primitive extension prefix/rebase and
disable machinery. Helpers may move behind the canonical boundary, but a
renamed second source of truth does not satisfy deletion.

## Validation

Tests are replaced, not accumulated. Tests that assert superseded behavior —
catalog merges, fallback construction, name-based dispatch, agent-info v2 —
are deleted with the code they cover and replaced by tight unit and
integration tests for the new boundaries. Test helpers obtain compiled
artifacts only through the real compiler, from filesystem fixtures or
in-memory source registration; no helper constructs `Compiled*` records
field-by-field.

The work adds no new e2e evals and no new scenario suites. Existing
scenario, TUI, and fixture-owned e2e suites are the behavioral regression
net: nearly all of them must continue passing unchanged, with modifications
limited to the named breaking surfaces — agent-info v3 assertions, the
health and info routes, and `eve/tools/<name>` import paths.

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

Fixture-owned e2e suites run in CI. Composition, replacement, and disablement
coverage lives in unit and integration tests against the real compiler, not
in new fixtures. The final required CI includes the deterministic world
suites and the real-model `e2e-local` aggregate; transport or provider
variance may be rerun, but repeated failures are investigated rather than
waived.

## Completion criteria

The implementation is complete only when:

1. A compiled artifact with missing binding, owner, composition, or route
   provenance cannot be constructed or loaded — enforced at construction and
   after disk or bundled schema parsing, before module-map hydration.
2. Every winner is bound before evaluation; losing filesystem exports and
   programmatic namespace loaders never execute during compilation or cold
   start.
3. Development, generated, materialized, bundled, hydrated, and in-memory
   module maps expose the same `(nodeId, sourceId)` set and invoke only
   selected programmatic loaders; no virtual disk path is probed.
4. Extension projection qualifies each primitive once, preserves package
   backing and external dependencies, and retains ownership across nested and
   duplicate extension subagent mounts; no per-primitive merge or origin
   table remains.
5. Removing a selected framework source removes its runtime behavior; no
   runtime layer recreates it. Default and authored sandboxes and configs each
   have one truthful selected source, and filesystem and memory compilation
   report identical provenance.
6. Every active ordinary capability appears once by public identity in the
   compiled graph and once in inspection; named primitives use their runtime
   name, routes use method plus normalized path pattern. Nitro registers no
   ordinary route or generated preflight absent from the compiled channel
   route plan, and route-planning failures use their stable compile error
   codes.
7. Every kernel effect kind, every dispatch action kind, and the
   `final_output` interception are covered through preparation, advertisement,
   materialization, dispatch, prompts, and inspection for root, self-delegated
   root, named and dynamic task children, non-task children,
   provider-dependent calls, Workflow depth, and structured output. Named task
   children receive `task_update`. No harness or execution code branches on a
   tool name or source ID.
8. Connection search preserves filtering, auth, approval, failure, long-name,
   durable callback, and restart behavior without history scanning; home and
   eve-channel replacement, client payload validation for health and info,
   and internal process readiness agree without a native fallback.
9. Agent-info explains the owner and replacement history of every config,
   primitive, route, local subagent, remote agent, and dynamic resolver
   without parsing identifiers; `AgentInfoResultSchema` validates exact unique
   sets and counts, and Nitro's ordinary routes equal agent-info channels.
10. Searches for the distributed deletion ledger return no production match or
    renamed equivalent.
11. Changing a selected filesystem module or programmatic executable revision
    changes module-map identity, while relocating identical filesystem content
    without changing its logical extension namespace does not.
12. The complete implementation lands with all required local and CI
    validation passing, existing higher-level suites modified only at the
    named breaking surfaces, no new e2e or scenario suites, and no new
    `guard-invariants` rules.

## Invariants and rejected alternatives

- Logical paths remain eve's only definition naming grammar. Backing, owner,
  and source ID never change normalization semantics.
- One candidate composer chooses before definition execution. There is no
  per-primitive precedence, disable implementation, or separate subagent
  composer.
- Required compiled bindings are the only authority for namespace loading.
  Inferred physical paths, diagnostic metadata, and virtual disk fallback
  cannot affect behavior; derived module dependencies and parameters are
  required backing data because they do affect behavior.
- Programmatic construction is explicit, immutable, statically reachable, and
  lazy. There is no global registry, runtime graph mutation, function
  serialization, generated temporary source, or unselected namespace
  evaluation. Every binding pins the registered source revision and rejects a
  different implementation before load.
- Active ownership has one location. Composition entries own only losing or
  disabled provenance; no winner-owner index or origin table is retained.
- The design is self-enforcing. A boundary that needs a new mechanical guard
  rule, an AST check over the implementation's own interfaces, or an
  identifier-name pattern to survive is a design failure to correct, not a
  guard to add.
- `defineDynamic` remains the sole dynamic-definition lifecycle. Framework and
  future memory features do not gain parallel validation, durability,
  replacement, collision, or callback stores.
- Kernel effects are declared on public definitions and implemented by the
  kernel. Tool definitions never import Workflow, harness, or execution
  internals, and no effect is keyed by tool name.
- Ordinary route dispatch comes only from the compiled route plan. Native
  behavior is limited to the closed kernel effect kinds and host inventory; a
  universal native-tool, route, or adapter escape hatch is rejected.
- Pre-1.0 cleanup is a breaking replacement: no legacy manifest reader,
  agent-info schema, health fallback, history reconstruction, duplicate status
  state, or compatibility path is retained.
