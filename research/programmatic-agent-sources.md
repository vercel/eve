---
issue: https://github.com/vercel/eve/issues/2347
status: in-progress
last_updated: "2026-08-22"
---

# Programmatic agent sources

## Decision

Compile one effective agent source graph. Filesystem discovery, extension
packages, extension overrides, and framework-owned programmatic modules all
produce candidates for the same path-derived slots. One composer selects the
winner for each slot before any definition executes, and the ordinary compiler
normalizes only those winners.

```text
framework modules ───────┐
extension packages ──────┤
extension overrides ─────┼─> classify + compose ─> effective source graph
application filesystem ──┘                                │
                                                          ├─> compiler/module map
                                                          ├─> runtime graph
                                                          ├─> Nitro routes
                                                          └─> inspection
```

Logical identity and physical storage are separate. A logical path selects an
eve slot and derives its public name. A backing binding says how to load that
slot. `agent/tools/search.ts` and an immutable in-memory namespace registered
at `tools/search.ts` therefore compile identically without pretending that the
programmatic module exists on disk.

The framework API is internal. Programmatic modules export ordinary public eve
definitions: `defineTool`, `defineDynamic`, `defineChannel`, `defineSandbox`,
and the existing connection, hook, schedule, instruction, and skill factories.
They never construct `Compiled*` or `Resolved*` records. Production runtime
behavior continues to live in the `eve` package; generated module maps only
bind statically reachable module namespaces.

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
- make module backing a required part of every compiled node;
- compose framework defaults, extensions, overrides, and application sources
  once;
- compile one effective manifest consumed by runtime, Nitro, bundling, and
  inspection;
- migrate ordinary framework tools, `connection_search`, framework channels,
  and the default sandbox to programmatic eve modules;
- replace scattered native-tool knowledge with one closed kernel capability
  inventory;
- replace agent-info v2 with a truthful v3 projection;
- remove the old framework, extension-composition, fallback, and inspection
  paths in the same implementation.

The first version does not expose a public registration API, serialize
functions, mutate a compiled graph, create programmatic subagent nodes, or
virtualize markdown and skill asset files. Programmatic modules may be applied
to already-discovered local nodes, but may not recursively introduce nodes,
extensions, or raw workspace content.

## Source model

### Programmatic modules

Programmatic sources contain immutable module namespaces at virtual
agent-relative paths:

```ts
type ProgrammaticModuleNamespace = Readonly<Record<string, unknown>>;

interface ProgrammaticAgentModule {
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly namespace: ProgrammaticModuleNamespace;
}

interface ProgrammaticAgentSource {
  readonly id: string;
  readonly modules: readonly ProgrammaticAgentModule[];
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
sync or async factory. Construction shallow-copies and freezes the source,
module array, and namespace containers without cloning definition values. This
preserves brands, symbols, functions, and durable callback metadata.
Programmatic source IDs derive deterministically as
`<source.id>:<logicalPath>` and must be unique within each node.

Registries are explicitly assembled, statically imported, and immutable before
compilation. They are not global, side-effect-populated, or mutable runtime
registries. `root` applies only to the application root. `all-local-nodes` is a
finite overlay applied after filesystem and extension nodes are discovered; it
rejects `agent.ts`, `subagents/**`, `channels/**`, `schedules/**`, and
`extensions/**` so registration cannot expand the graph recursively.

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
loading uses the exact registry/module pair. Missing programmatic bindings fail
without probing a virtual path on disk. `sourceId` remains stable provenance
and module-map identity; provider kind and precedence are never inferred from
it.

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
```

Compilation fails unless every module-backed manifest reference has exactly one
binding and every binding is referenced. The binding table participates in
artifact versioning and hashing. Development hydration, generated module maps,
bundled artifacts, materialized artifacts, and cold-start reconstruction all
read this same table. Optional diagnostic metadata may summarize compilation,
but the process cannot load or inspect an agent without its bindings.

Generated maps emit ordinary static imports for filesystem modules and
statically reachable registry lookups for programmatic modules. The resulting
`CompiledModuleMap` remains the only namespace map used by graph resolution.

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
   composition report.

An invalid winner fails compilation and never falls back to the shadowed
candidate. Disable sentinels and shadowed definitions do not survive in
compiled or resolved runtime types. The composition report is for compiler
diagnostics and inspection provenance; runtime behavior never recomposes it.

Identity uses the existing canonical equivalence rules: `.js` and `.ts`
variants select the same slot, connection file/folder forms collide, and tool
names flattened from different paths retain their current collision errors.
Dynamic outputs remain subject to the existing runtime lifecycle rules after
their resolver source has composed.

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
bindings, the composition report, and the prepared kernel capability plan.
Every downstream consumer reads it:

- graph resolution registers only compiled resources;
- Nitro registers only the compiled ordered channel routes;
- development and production module maps load only required bindings;
- CLI, Vercel build summaries, and agent info project the same resources;
- no consumer imports a framework tool or channel catalog and merges it again.

Channel modules compose by logical slot before route expansion. The compiler
then preserves selected module order and applies one deterministic first-wins
`(method, path)` route policy. The winning route owns dispatch and CORS
preflight. Runtime dispatch, WebSocket detection, and Nitro development and
production route generation consume that identical ordered route list.

The test-only in-memory compiler must also become a source provider for this
pipeline. It may supply namespaces directly, but it may not construct compiled
descriptors or empty module-map entries by hand. Tests that need realistic
compilation use the same composer and normalizers as production.

## Framework migration

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

`load_skill` should also become an ordinary public definition at
`tools/load_skill.ts`. Its executor reads an eve-owned skill-catalog context
provider instead of closing over resolved skills. The kernel inventory may
still gate advertisement on whether the node can load a static or dynamic
skill, but it must not fabricate a second definition. If this spike cannot
preserve dynamic-skill and cold-start behavior, the capability remains native
and the implementation must document the missing primitive rather than add a
special source type.

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
resolution no longer invents a framework sandbox when the compiled manifest
has none.

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

HTTP adapter availability is derived from effective compiled channel routes;
there is no synthetic adapter source slot. Schedule and subagent adapters
remain a small native rehydration inventory because they represent durable
framework transport, not authored agent files. The runtime adapter registry
combines those native entries with adapters referenced by compiled routes; it
does not maintain a separate list of framework features.

### Kernel capabilities

Native harness behavior cannot honestly be modeled as an ordinary executor
yet. Keep one exhaustive typed inventory instead of fake resolved definitions
and literal name lists spread through graph, harness, prompt, dispatch, and
inspection code.

Each entry owns its canonical replacement path, reservation policy, node-level
preparation, session/model advertisement predicate, materialization, runtime
dispatch kind, prompt flags, and inspection projection. The closed inventory
is:

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

Preparation and advertisement are deliberately separate: a self-delegated or
task child can share the root node while receiving a different model-visible
tool set. Build inspection reports prepared potential, never claims to be the
exact tools for every session and model call.

## Inspection v3

Replace agent-info v2 instead of preserving fields whose meanings no longer
fit. The `/eve/v1/info` payload becomes version 3 and has one projector from the
effective compiled graph, binding owners, composition diagnostics, and kernel
plan. All in-repository clients, TUI views, eval targeting, and tests migrate in
the same change; there is no v2 fallback before 1.0.

Version 3 reports:

- active static definitions in one list per primitive, each with its logical
  path, source ID, and owner (`application`, `extension`, or `framework`);
- active dynamic resolvers separately from their session-specific outputs;
- prepared kernel capabilities separately from compiled tool definitions,
  including their audience/model conditions;
- one effective ordered channel-route list;
- composition diagnostic summaries for shadowed or disabled candidates, never
  duplicate resource rows.

It removes `available`, `authored`, `framework`, `disabledFramework`,
`replacesFramework*`, `disabledByAuthor`, and the
`active | disabled | opt-in | replaced` framework status taxonomy. Active
resources can be grouped by owner without duplicating them. Disabled and
shadowed candidates remain compiler composition diagnostics, not runtime
agent state.

Normalizers continue recording safe facts that cannot be reconstructed from
serialized JSON, such as execution presence, approval, schemas, model-output
projection, adapter kind, and route identity. They never serialize callbacks.
Tool `hasAuth` remains false because arbitrary executor calls to `getToken()` or
`requireAuth()` cannot be inferred statically.

`eve info --json` and Vercel summaries keep their narrower contracts but use
the same effective compiled resources. They do not grow session-specific
dynamic outputs or pretend prepared kernel potential is a concrete model-call
tool set.

## Memory lifecycle proof still required

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
reconstruct the wrapper and resume a parked provider-tool call. This is an
implementation acceptance item, not work performed by the research PR.

## Delivery

This implementation is a serial stack with one deliberately large core
migration. Source-neutral bindings and composition can land independently, as
can inspection, the test-only in-memory compiler, and documentation. Moving
framework capabilities cannot be split by primitive: generated binding
reachability, framework and extension precedence, legacy-path deletion, and
the closed kernel inventory must change together or an intermediate manifest
can contain bindings with no executable owner.

The landing order is:

1. establish source-neutral module bindings;
2. establish the canonical source composer;
3. atomically move the default sandbox, ordinary framework tools,
   `connection_search`, `load_skill`, `web_search`, the eve channel, and
   callback routes onto that composer; project extension packages and
   overrides into the same slots; install the closed kernel inventory; and
   delete the superseded compiler and runtime machinery;
4. replace agent-info v2 with the single v3 projector;
5. route the test-only in-memory compiler through the same source graph; and
6. finish with documentation, deterministic fixture inspection, and one minor
   changeset for the breaking inspection contract.

The memory lifecycle proof is intentionally not part of this stack. It remains
a required follow-up before memory may adopt programmatic sources, as specified
in [Memory lifecycle proof still required](#memory-lifecycle-proof-still-required).
It must not introduce a compatibility layer or a memory-only contributor seam.

## Required deletions

The implementation is incomplete until it removes:

- the catalogs in `runtime/framework-tools/index.ts` and
  `runtime/framework-channels/index.ts`;
- duplicate framework `ResolvedToolDefinition` constants, callback
  `ResolvedChannelDefinition` builders, and all direct framework construction
  of `Compiled*` or `Resolved*` values;
- framework merge and disable branches in graph resolution and Nitro route
  registration;
- `getAllFramework*Names`, runtime/compiled `disabledFramework*` arrays, and
  source-ID-prefix ownership checks;
- the public/internal tool-definition converter and duplicate default-tool
  wrappers;
- the `connection_search` history scanner, context/history merge, synthetic
  slug, graph append, and separate dynamic registry;
- `composeManifestContributions`, `mergeContributions`,
  `applyOverrideDisables`, per-primitive extension prefix/rebase code, and their
  name-based dedupe helpers;
- the default-sandbox definition fallback when no source exists;
- the parallel manifest/resolved agent-info builders and v2 framework status
  reconstruction;
- the in-memory compiler shortcut that hand-builds compiled descriptors or
  module namespaces.

Implementation helpers may move and be reused, but no second source catalog,
composer, or downstream merge may remain under a new name. The final diff
should be a substantial net deletion of framework-specific machinery.

## Validation

- Prove filesystem and programmatic parity for representative static and
  dynamic tools, connections, channels (including WebSocket and `receive`),
  schedules, sandboxes, module instructions, and module skills. Cover exports,
  factories, brands, callback metadata, invalid paths, and duplicate slots.
- Exercise precedence and disablement across framework defaults, extension
  packages, extension overrides, root application sources, and every local
  node. Assert that losing candidates are never executed or normalized.
- Verify extension path projection qualifies each primitive once, preserves
  physical package loading and external dependencies, and leaves no
  per-primitive merge behavior.
- Verify development, generated, bundled, materialized, and in-memory module
  maps bind the same `(nodeId, sourceId)` pairs, never import virtual disk
  paths, fail on missing or extra bindings, and reconstruct programmatic
  namespaces on a cold process.
- Preserve `connection_search` filtering, failures, approval, authorization,
  long-name, durable callback, and restart coverage. Assert old state without
  `ConnectionSearchResultsKey` searches again and never scans history.
- Preserve sandbox backend selection while proving the selected compiled
  `sandbox.ts` owns provenance and application replacement.
- Assert the default eve channel's complete route order, auth, CORS, and HTTP
  behavior. Dispatch all six callback identities through the ordinary route
  path and preserve their exact response contracts. Route collisions must pick
  the same winner for dispatch and preflight in development and production.
- Exercise every kernel capability through reservation, preparation,
  advertisement, materialization, dispatch, prompt flags, and v3 inspection,
  including root, self-delegated, task-child, model-dependent, Workflow, and
  structured-output sessions.
- Verify v3 agent info, CLI JSON, Vercel summaries, TUI setup detection, and eval
  targeting project the same effective resources without reconstructing
  framework state.
- Complete the separate memory lifecycle proof above before memory adopts the
  source API.
- Run formatting, lint, typecheck, invariant guards, build, focused
  unit/integration/scenario tests, and relevant fixture evals.

## Invariants and rejected alternatives

- Logical paths remain eve's only definition naming grammar. Backing, owner,
  and source ID never change normalization semantics.
- One candidate composer chooses before definition execution. There is no
  per-primitive precedence or disable implementation.
- Required compiled bindings are the only authority for namespace loading.
  Optional metadata and virtual disk fallback cannot affect behavior.
- Programmatic construction is explicit, immutable, statically reachable, and
  complete before compile. There is no global registry, runtime graph mutation,
  function serialization, or generated temporary source.
- `defineDynamic` remains the sole dynamic-definition lifecycle. Framework and
  future memory features do not gain parallel validation, durability,
  replacement, collision, or callback stores.
- Native behavior is limited to the closed kernel and durable-adapter
  inventories. A universal native-tool or adapter escape hatch is rejected.
- Pre-1.0 cleanup is a breaking replacement: no legacy agent-info schema,
  history reconstruction, duplicate status state, or compatibility fallback is
  retained.
