---
issue: https://github.com/vercel/eve/issues/2347
status: implemented
last_updated: "2026-08-31"
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
schedule, instruction, and skill factories. Framework-only native tools use a
closed internal definition variant so they do not carry fake throwing
executors. Neither form constructs `Compiled*` or `Resolved*` records.
Production runtime behavior continues to live in the `eve` package; generated
module maps only bind statically reachable module namespaces.

The compiled manifest, required bindings, persisted composition report,
compiler-owned channel route plan, selected tools' handling descriptors, and
closed host inventory are the only downstream authority. An active
module-backed source is owned by its binding. An active non-module source is
owned by its explicit compiled source record. A losing or disabled source is
owned by its self-contained composition entry. No second winner-owner index,
kernel plan, or out-of-band origin table may exist.

Every ordinary framework default is a first-class eve primitive at a canonical
logical path, including the default `agent.ts`, sandbox, home page, and the
eve channel carrying the public health and info endpoints. Native execution
may implement a selected primitive, but it may not create that primitive's
presence independently of the source graph.
Model-visible native behavior is keyed by a closed handling descriptor carried
by the selected tool — never inferred from its tool name, source ID, owner, or
logical path. Host registrations that cannot be ordinary sources live in a
separate, typed, exhaustive inventory.

This supersedes the runtime-tool contribution seam in #2347. Runtime
contribution is too late for channels, schedules, sandboxes, host routes,
bundling, and inspection, and would create another collision, durability, and
dispatch system for tools.

## Current state

The source-graph phase landed in [#2516](https://github.com/vercel/eve/pull/2516).
Derived slot composition landed in
[#2539](https://github.com/vercel/eve/pull/2539), and first-class memory now
uses that boundary through [#2534](https://github.com/vercel/eve/pull/2534).
Manifest v45 and agent-info v4 are current on `main`.

Those changes completed source selection, binding, loading, route planning,
ownership, and memory integration. They deliberately preserved the dispatch
seam for a second phase. The remaining work is narrower than the original
kernel-effects proposal: make each selected tool carry its own handling and
availability metadata through compilation and runtime preparation, then delete
the harness and execution code that infers those facts from names, owners,
paths, markers, or function identity.

## Problem

Before #2516, the compiler tracked `logicalPath` and `sourceId`, but module
loading still assumed every source lived at `agentRoot + logicalPath`.
Framework and extension features worked around that assumption at different
layers:

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

The source graph removed those parallel composition paths, but native dispatch
still infers semantics after resolution:

- `createExecutionNodeStep` recognizes framework `agent`, `ask_question`, task
  controls, and `load_skill` through owner-and-name checks;
- the harness recognizes `ask_question` and `web_search` by model-visible name;
- task control is classified through `TASK_TOOL_NAMES` and dispatched by name;
- `load_skill` retains a `frameworkAction` marker to classify action events
  even though it executes inline;
- task-mode local subagent fanout uses a module-global `WeakSet` of executor
  function identities;
- root-only, delegated-caller-only, Workflow-callable, and request-input
  availability are separate booleans and name checks; and
- agent-info reconstructs `kernelEffects` from a hard-coded logical-slot table
  instead of the selected compiled tool.

`final_output` is different: eve creates it for one model call from that
turn's output schema, so it has no selected source to carry metadata. Its
terminal interception stays explicit and localized outside the source graph.

The result is duplicate machinery with inconsistent identity. Replacement,
disablement, route order, source provenance, cold-start loading, and inspection
depend on which path created a definition. The refactor succeeds only when
those parallel paths are deleted, not hidden behind a new registry.

## Scope

The complete work includes:

- introduce source-neutral candidate, composition, and loading boundaries;
- require complete module bindings at artifact construction, compilation, and
  load, including bindings created for application candidates before their
  definitions execute;
- compose framework defaults, extensions, overrides, and application sources
  once, including local subagent source nodes;
- compile one effective manifest consumed by runtime, Nitro, bundling, and
  inspection;
- migrate ordinary and native-handled framework tools, `connection_search`, the
  eve channel (carrying the callbacks, health, and info), the home channel,
  the default sandbox, and the default `agent.ts` to programmatic eve
  modules;
- separate public primitive definitions, execution implementations, and native
  handling metadata so each ordinary default has one definition value;
- carry a closed internal handling descriptor on each selected native-handled
  tool and each graph-derived delegation tool, covering availability,
  materialization, dispatch, and inspection without a parallel plan;
- limit non-source host behavior to an explicit closed host inventory and move
  process readiness away from the replaceable public health route;
- keep agent-info projected from the effective graph and selected tool
  descriptors rather than reconstructing framework behavior from paths;
- remove each superseded framework, extension-composition, fallback, and
  inspection path in the delivery PR that supersedes it.

The implementation does not expose a public registration API or public
handling constructors, serialize functions, mutate a compiled graph, create
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

interface RegisteredProgrammaticTemplate {
  readonly module: ProgrammaticAgentModule;
  readonly source: ProgrammaticAgentSource;
}

interface AgentSourceRegistry {
  readonly registrations: readonly AgentSourceRegistration[];
  readonly sources: ReadonlyMap<string, ProgrammaticAgentSource>;
  readonly templates: ReadonlyMap<string, RegisteredProgrammaticTemplate>;
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
compilation. Registrations are source overlays; each template is a single
loadable module implementation used only by derived candidates and never
injects a candidate on its own. Registration returns an opaque template handle,
so candidate construction cannot accept an arbitrary unregistered source.
Registries are not global, side-effect-populated, or mutable at runtime. `root`
applies only to the application root. `all-local-nodes` is a finite overlay
applied after filesystem and extension nodes are discovered; it rejects
`agent.ts`, `subagents/**`, `channels/**`, `schedules/**`, and `extensions/**`.
A closed internal framework registration is the narrow exception that may
provide the default `agent.ts` for every already-discovered local node.
Arbitrary programmatic sources cannot use config to expand the graph recursively.

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

type AgentSourceForm = "derived" | "direct";

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

`direct` means contributed to a slot without derivation; it does not imply a
filesystem-authored or application-owned source.

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

```ts
function instantiateProgrammaticTemplate(input: {
  readonly anchor: AgentModuleCandidate;
  readonly dependencies: Readonly<Record<string, AgentModuleCandidate>>;
  readonly logicalPath: string;
  readonly owner: AgentSourceOwner;
  readonly parameters?: JsonObject;
  readonly template: RegisteredProgrammaticTemplate;
}): AgentModuleCandidate;
```

`instantiateProgrammaticTemplate` requires a registry-issued template and an
anchor candidate. It inherits the anchor's node and layer, derives stable
provenance from the template, target path, and anchor source ID, and records
dependency aliases as selected source IDs plus behavior-critical JSON
`parameters` in the programmatic backing. The anchor must be one of those
dependencies, every dependency must belong to its node, and all dependencies
must remain selected after composition. The constructor does not evaluate any
module. A direct candidate wins over a derived candidate within the same source
layer. Normal cross-layer precedence still applies, so an application-derived
capability can replace an extension contribution while a direct application
source can replace or disable the derived capability.

Templates are not an open projection callback or a mutable registry. A closed
compiler feature decides when to instantiate one from the already-discovered
source graph, then the ordinary composer, binding table, normalizers, and
module maps take over. Compiled dependency graphs reject missing bindings and
cycles. Compilation, in-memory hydration, and generated module maps resolve
dependencies in order and cache each selected namespace once per phase.
Namespace caching does not cache materialized zero-argument definition exports;
a feature that requires one shared definition instance across multiple slots
must provide a separate per-phase materialization boundary.

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
derived < direct within one layer
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
bindings, the composition report, and a compiler-owned channel route plan.
Native handling is a field on each selected compiled tool, not a second plan.
Instrumentation, the Workflow world, sandbox workspace assets, external
dependencies, and prepared tool handling are per-binding data, ordinary slot
content, existing config, or runtime projections. Introducing another named
plan artifact requires amending this document first. Every downstream consumer
reads the effective graph:

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
| `tools/load_skill.ts`        | `defineTool`                           | every local node | ordinary executor                                                     |
| `tools/connection_search.ts` | `defineDynamic`                        | every local node | discovers and qualifies connection tools                              |
| `tools/ask_question.ts`      | internal native tool + `request-input` | every local node | visibility: `requires-request-input`                                  |
| `tools/agent.ts`             | internal native tool + `dispatch`      | root node        | action: `subagent-call`; visibility: `root-session`                   |
| `tools/task_update.ts`       | internal native tool + `dispatch`      | root node        | action: `task-update`; tasks mode; visibility: `delegated-task-child` |
| `tools/task_cancel.ts`       | internal native tool + `dispatch`      | root node        | action: `task-cancel`; tasks mode; visibility: `root-session`         |
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

Canonical tool definitions and contracts live under `tools/`; package-facing
modules under `public/tools/` remain thin adapters. Execution-only
implementations and durable state live under `execution/`, while the harness
continues to own model-loop and pending-input behavior. A native-handling
descriptor does not justify a new `kernel/` subsystem.

Each ordinary default has exactly one definition value. Its framework source
module and its public `eve/tools/<name>` subpath export import that same
value; there is no barrel export. Moving modules must
preserve durable state key identity for todo, read-before-write, skill,
connection-search, compaction, and task behavior. These boundaries hold
structurally: public modules do not import `runtime/`, ordinary framework
sources construct only canonical definitions, and execution code receives
prepared handling metadata instead of rediscovering source identity.

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

`load_skill` already has a real executor. Delete its
`frameworkAction: "load-skill"` marker. Its availability gate — whether the
node can load a static or dynamic skill — and its skill-specific action-event
presentation become selected tool metadata rather than a fabricated second
definition. Existing action request/result wire kinds may remain as protocol
presentation; they must not make `load_skill` a durable dispatch action.
Dynamic-skill and cold-start behavior use the same compiled source and selected
binding; no special source type or native fallback remains.

### Native-handled tools

`ask_question`, `agent`, `task_update`, and `task_cancel` are closed internal
native-tool definitions, and `web_search` is the `webSearch()` sentinel. They
compose, replace, and disable in ordinary tool slots. Each framework definition
carries closed, internal behavior metadata; the compiler serializes that
metadata on the selected tool itself:

```ts
type CompiledToolHandling =
  | { readonly kind: "request-input"; readonly request: "question" }
  | {
      readonly kind: "dispatch";
      readonly action: "self-agent" | "task-update" | "task-cancel";
    }
  | { readonly kind: "provider-tool"; readonly provider: "web-search" };

interface CompiledToolBehavior {
  readonly availability: readonly ToolAvailabilityCondition[];
  readonly handling?: CompiledToolHandling;
  readonly presentation?: "skill";
}

type PreparedDispatchTarget =
  | { readonly kind: "subagent-call"; readonly nodeId: string; readonly subagentName: string }
  | { readonly kind: "self-agent-call"; readonly nodeId: string; readonly subagentName: string }
  | {
      readonly kind: "remote-agent-call";
      readonly nodeId: string;
      readonly remoteAgentName: string;
    }
  | { readonly kind: "task-update" }
  | { readonly kind: "task-cancel" };

interface PendingDispatchAction {
  readonly callId: string;
  readonly description: string;
  readonly input: JsonObject;
  readonly target: PreparedDispatchTarget;
  readonly toolName: string;
}

type ToolAvailabilityCondition = "root-session" | "delegated-task-child" | "requires-request-input";
```

The internal constructor creates a truthful execute-less native definition and
stamps its behavior metadata; no public `defineTool` option exposes this form.
The normalizer reads the declaration only from the selected namespace and
persists it on `CompiledToolDefinition`; cold-start loading never reconstructs
it from the logical path. An application `defineTool(...)` at
`tools/ask_question.ts` therefore becomes an ordinary executor, while an
application `webSearch(...)` retains provider handling because the selected
sentinel declares it. `load_skill` remains an ordinary executable tool whose
behavior carries presentation, an empty availability set, and no native handling.

Runtime preparation expands `self-agent` and graph-derived local or remote
subagents into `PreparedDispatchTarget` values with concrete node identity.
Availability travels beside the prepared tool. The harness evaluates those
conditions and switches on the handling discriminator; it does not inspect the
tool's owner, name, path, executor identity, or a second plan. An absent
handling declaration means ordinary execution. Tasks mode may materialize an
agent-call dispatch as the existing background executor, but the prepared
dispatch kind remains available for Workflow filtering and local fanout.

Workflow remains a source-selected sentinel with no framework default. Its
program sandbox receives only prepared `dispatch` tools whose actions are
local or remote agent calls; task actions remain unavailable. Workflow reuses
the existing runtime-action dispatch and durable continuation paths rather
than minting an effect kind or global capability lifecycle. Despite the shared
name, `defineAgent({ experimental: { workflow } })` still selects the durable
runtime world backing the agent's own execution and is not a tool identity.

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
diagnostics, and selected tool descriptors — not a special source kind or
build-time native route.

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

### Typed tool handling

The durable mechanisms already exist and remain with their current owners.
Pending input, approvals, and authorization are harness concerns. Runtime
action batches, child dispatch, task control, and Workflow continuation are
execution concerns. Provider-tool materialization belongs next to the model
call. Phase 2 does not move those implementations behind a universal kernel
strategy object.

The missing boundary is the typed handoff between those layers:

```text
selected definition ─> CompiledToolDefinition.behavior
                                │
                                ├─> prepared source-backed tool
subagent graph ─────────────────┴─> prepared delegation tool
                                            │
                                            ├─> availability filter
                                            ├─> model-tool materialization
                                            ├─> pending input or action request
                                            └─> agent-info projection
```

Compiler normalization copies the internal declaration from the selected
definition to its `CompiledToolDefinition`. Runtime resolution carries that
compiled behavior into one uniform prepared-tool descriptor; execute-less
native tools do not need to reload a module merely to recover behavior. Local
and remote subagent graph entries join at that prepared boundary with concrete
dispatch targets; they do not need a fabricated source definition or a global
catalog.

The harness evaluates availability before materialization. It handles
`request-input`, `dispatch`, and `provider-tool` through exhaustive switches on
the descriptor, while an ordinary tool follows its executor. The existing
pending-input and pending-dispatch records remain authoritative for resume. The
broad action-event union remains a protocol projection for clients; the pending
batch narrows to `PendingDispatchAction` values. Plain tool calls and
`load-skill` presentation must not enter the durable dispatch planner. Approvals
remain an orthogonal gate on any executable tool and do not become a declared
`request-input` operation.

Task control requests carry `task-update` or `task-cancel` in the typed action
itself. The execution step switches on that action instead of recovering it
from `toolName`. Background subagent batches carry local or remote dispatch
identity in their prepared definitions, which removes
`localSubagentExecutors` without changing task admission, fanout, or durable
child ownership.

`final_output` remains the sole per-turn native tool. It is created only when
a turn has an output schema, and the terminal-output module owns both its
model-visible name and extraction. Other harness and execution modules receive
the typed terminal result; the source graph does not fabricate a static slot.

This boundary is intentionally distributed by ownership. It adds no
`kernelPlan` artifact, capability registry, strategy table, semantic validator,
or guard rule. The closed TypeScript unions make new handling and dispatch
kinds fail at their actual integration switches. Replacing or disabling a
framework source removes its descriptor because no downstream layer can infer
it from the vacated logical path.

## Inspection

Agent-info v3 landed with #2516, and first-class memory advanced the current
payload to v4. Phase 2 does not replace that schema. The `/eve/v1/info` route
continues to project from the effective compiled graph and remains an ordinary
route of `channels/eve.ts`.

Agent-info reports:

- the selected default or authored agent config with its binding and owner;
- active static definitions in one list per primitive, each with its logical
  path, source ID, and owner (`application`, `extension`, or `framework`);
- active dynamic resolvers separately from their session-specific outputs,
  including exact subscribed events and explicit source provenance;
- prepared native handling as an inspection projection, including its
  availability conditions;
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
The native-handling projection comes from each selected compiled tool and
prepared graph-derived delegation descriptor. Delete `KERNEL_EFFECT_BY_SLOT`;
inspection must not parse a logical path or owner to rediscover behavior.
Channel entries continue to come directly from
`manifest.channelRoutes.effective`.

Normalizers continue recording safe facts that cannot be reconstructed from
serialized JSON, such as execution presence, approval, schemas, model-output
projection, adapter kind, and route identity. They never serialize callbacks.
Tool `hasAuth` remains false because arbitrary executor calls to `getToken()` or
`requireAuth()` cannot be inferred statically.

`eve info --json` and Vercel summaries keep their narrower contracts but use
the same effective compiled resources. They do not grow session-specific
dynamic outputs or pretend prepared native potential is a concrete model-call
tool set.

## In-memory compiler parity

The test-only in-memory compiler declares each programmatic application source
once. That registration derives its candidate, binding, manifest reference,
composition entry, and owner. It supplies complete bindings and composition to
the ordinary constructors, includes the framework default `agent.ts`, and
proves authored config replacement through the same phase-one composer.

Filesystem and memory fixtures must produce equivalent source owners, config
provenance, tool-handling descriptors, and module-map key sets. Cold-start
namespace reconstruction and durable callback replay use registry/module
bindings only; neither logical paths nor source IDs recover missing backing or
provenance.

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

The source-identity half is complete: #2516 landed the canonical graph, #2539
landed derived slots, #2534 moved memory onto them, and #2531 consolidated the
tool source layout. Issue #2347 was closed when the runtime-contribution seam
was superseded. Phase 2 can now be reviewed independently against current
`main`.

The original Phase 2 implementation shape is rejected. The discarded
`barba/exhaustive-kernel-lifecycle` attempt added 4,617 lines while deleting
734, including a separate 476-line kernel-plan semantic validator and 486 lines
of invariant-guard machinery. It reproduced source facts in a capability
strategy table and made no-op lifecycle methods part of the architecture. That
is the inverse of the replacement ratio and self-enforcing boundary required
by this plan.

### Phase 2 — typed tool handling

Phase 2 is one focused, behavior-preserving refactor:

1. Add closed internal handling and availability declarations to the canonical
   framework definitions, and serialize them on the selected
   `CompiledToolDefinition`.
2. Carry those declarations through runtime resolution into prepared tools;
   create the same prepared dispatch shape directly from local and remote
   subagent graph entries.
3. Make harness availability, question extraction, provider materialization,
   runtime-action creation, Workflow host filtering, and agent-info projection
   consume the prepared descriptor.
4. Make task execution consume the typed dispatch action instead of
   `toolName`, and make background subagent fanout consume prepared delegation
   kind instead of executor function identity.
5. Delete every superseded marker, name table, owner-and-name branch,
   logical-slot inspection table, fake native executor, and broad action-event
   type from the pending dispatch boundary.

If the compiled descriptor changes the serialized manifest, increment the
manifest once from the version current when the PR starts. Do not reserve a
version in this research document. Agent-info remains v4 when its wire shape is
unchanged; `kernelEffects` may remain the public projection name while its data
comes from selected descriptors. The PR carries a `patch` changeset when
observable behavior is preserved.

Production deletions must meet or exceed new production machinery. A new
kernel plan, global capability registry, semantic validator, hand-built
artifact factory, or `guard-invariants` rule fails the design review.

The implemented boundary adds 171 lines across four focused behavior and
dispatch modules while deleting 498 lines from existing production modules.
It increments the compiled manifest to v46 and the backward-compatible tool
extension contract to epoch 23. No kernel plan, global registry, semantic
validator, artifact factory, or invariant rule was added.

## Phase 2 deletion ledger

The remaining work is incomplete while any listed path or equivalent parallel
system remains:

| Requirement group  | Required deletion                                                                                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handling authority | Owner-and-name dispatch in `execution/node-step.ts`; logical-path or owner reconstruction of native handling; `KERNEL_EFFECT_BY_SLOT`; any separate kernel plan, registry, strategy table, or semantic validator.                                                                        |
| Harness shape      | `frameworkAction`, `runtimeAction`, `rootOnly`, and `workflowCallable` as unrelated special fields; `ask_question` and `web_search` name gates outside their owning adapters; name-based hidden-tool and Workflow-host filtering.                                                        |
| Dispatch           | `TASK_TOOL_NAMES`; task update/cancel selection by `toolName`; `localSubagentExecutors` and executor-identity fanout; the broad action-event union as the pending dispatch contract; any source ID, logical path, owner, or model-visible name used to select a dispatch implementation. |
| Definition truth   | Framework definitions whose executors can only throw because a downstream name check is expected to intercept them. Native-handled definitions are execute-less; `load_skill` remains genuinely executable.                                                                              |
| Presentation       | The `frameworkAction: "load-skill"` marker and name-derived action presentation. If the special `load-skill` request/result wire projection remains, it derives from selected behavior metadata and stays separate from durable dispatch.                                                |
| Terminal output    | `final_output` name checks spread across the harness. The terminal-output module may own its reserved name, construction, and extraction because no source-backed identity exists.                                                                                                       |

Helpers may move behind the typed prepared-tool boundary, but a renamed second
source of truth does not satisfy deletion.

## Validation

Tests are replaced, not accumulated. Tests that assert name-based dispatch,
independent special fields, function-identity classification, or logical-slot
inspection are deleted with the code they cover. Replacement coverage proves:

- framework declarations survive compile, serialization, cold loading, and
  runtime preparation without path inference;
- an authored `defineTool` replacement at a framework slot executes ordinarily,
  while a selected `webSearch()` sentinel retains provider handling;
- request-input and availability semantics remain correct for root,
  self-delegated, scheduled, named, dynamic, and task-owned sessions;
- task controls and local or remote subagent calls reach the same existing
  durable dispatch paths from typed actions; and
- Workflow receives only eligible agent-call dispatch tools.

Test helpers obtain compiled artifacts only through the real compiler, from
filesystem fixtures or in-memory source registration; no helper constructs
`Compiled*` records field-by-field.

Phase 2 adds no new e2e evals or scenario suites. Existing scenario, TUI, and
fixture-owned e2e suites are the behavioral regression net and should remain
unchanged because the refactor preserves the public tool and agent-info
contracts.

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
7. Every selected native-handled tool carries one compiled handling descriptor,
   every local or remote delegation carries one prepared dispatch descriptor,
   and every handling and dispatch union is switched exhaustively at its owning
   layer. Root, self-delegated root, named and dynamic task children, non-task
   children, provider-dependent calls, Workflow depth, approvals, and
   structured output preserve their current behavior. Named task children
   receive `task_update`. No harness or execution code selects source-backed
   behavior from a tool name, logical path, owner, source ID, or executor
   identity.
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
    validation passing, existing higher-level suites behaviorally unchanged,
    no new e2e or scenario suites, no new plan artifact, and no new
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
- Native handling is internally declared on canonical definitions, serialized
  on selected compiled tools, and consumed through prepared descriptors.
  Public authoring APIs do not expose the declaration, definition modules do
  not import Workflow, harness, or execution internals, and no source-backed
  behavior is keyed by tool name.
- Ordinary route dispatch comes only from the compiled route plan. Native
  behavior is limited to the closed tool-handling union, the localized
  `final_output` interception, and the host inventory; a universal native-tool,
  route, or adapter escape hatch is rejected.
- Pre-1.0 cleanup is a breaking replacement: no legacy manifest reader,
  agent-info schema, health fallback, history reconstruction, duplicate status
  state, or compatibility path is retained.
