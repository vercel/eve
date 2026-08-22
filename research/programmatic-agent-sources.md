---
issue: https://github.com/vercel/eve/issues/2347
status: proposed
last_updated: "2026-08-21"
---

# Programmatic agent sources

## Decision

Separate an eve definition's logical identity from the storage that supplies
its module namespace. The filesystem remains the primary authoring interface,
but it becomes one source provider rather than a prerequisite of compilation.
Framework code may supply immutable programmatic sources containing ordinary
eve module exports at virtual agent-relative paths.

```text
filesystem modules ─────┐
                        ├─> composed source graph ─> compiler ─> module map
programmatic modules ───┘                                      │
                                                               ├─> runtime graph
                                                               ├─> host routes
                                                               └─> inspection
```

The logical path selects the agent slot and derives its name. Programmatic
tools still use `defineTool`, dynamic tools use `defineDynamic`, connections
use the existing connection factories, and channels use `defineChannel` or an
ordinary channel factory. Both providers pass through the same compiler,
serialized manifest, module map, runtime resolvers, and lifecycle code. No
programmatic source constructs a `Compiled*` or `Resolved*` value directly.

The first API is internal to the `eve` package. A public in-memory authoring API
is separate work because production builds need a statically importable way to
reconstruct every definition after a cold start.

This replaces the tool-only runtime contribution approach proposed in #2347.
A runtime contributor would give tools a second dispatcher, durable store,
collision model, and replacement path while remaining unable to represent
build-visible primitives such as channels and schedules.

## Current state

Filesystem discovery already gives the compiler the two identities it needs:

- `logicalPath`, which selects a slot and derives names;
- `sourceId`, which provides stable provenance and module-map lookup.

The compiler nevertheless reloads every module from
`agentRoot + logicalPath`. Framework features work around that assumption at
several unrelated layers:

- static framework tools are hand-built resolved definitions with synthetic
  source metadata;
- `connection_search` is a real `defineDynamic` value appended after ordinary
  graph resolution through invented path and slug metadata;
- the default eve channel and six callback routes fabricate resolved channel
  entries instead of using the channel compiler;
- graph resolution, Nitro route generation, and inspection each repeat their
  own framework replacement and disable logic;
- `agent`, `task_*`, `ask_question`, `web_search`, and `load_skill` use catalog
  stubs that are not the definitions executed by the harness.

These paths already disagree. `connection_search` cannot be disabled or
overridden normally, inspection can report task tools when tasks are off, and
framework channels lose parts of the public channel value. The solution is a
source-neutral module boundary, not another registry for each primitive.

## Scope

This work will:

- register framework-owned eve definitions at virtual agent paths;
- preserve path-derived identity and existing definition normalization;
- compose framework defaults and application sources once, before compile;
- reconstruct live namespaces without serializing functions or generating
  temporary files;
- make compile-time, host, runtime, and inspection consumers read the same
  effective graph;
- keep genuinely native harness capabilities explicit until eve primitives
  can express them honestly.

The first version does not expose public registration, mutate a compiled graph,
create programmatic subagent nodes, or virtualize markdown, skill assets, or
sandbox workspace files. It also does not migrate the default sandbox or the
channel-adapter registry; those can use the same source model later.

## Internal API

Programmatic sources describe module namespaces, not definitions:

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
  readonly source: ProgrammaticAgentSource;
  readonly applyTo: "root" | "all-local-nodes";
}

function createAgentSourceRegistry(
  registrations: readonly AgentSourceRegistration[],
): AgentSourceRegistry;
```

For example:

```ts
const frameworkNodeDefaults = defineProgrammaticAgentSource({
  id: "eve:framework:node",
  modules: [
    { logicalPath: "tools/bash.ts", namespace: { default: bash } },
    {
      logicalPath: "tools/connection_search.ts",
      namespace: { default: connectionSearch },
    },
  ],
});
```

The contract is deliberately filesystem-shaped:

- `logicalPath` is a normalized POSIX path relative to an agent root. It must
  match the existing module grammar and may not be absolute, traverse with
  `..`, or select a raw-resource-only slot.
- The path is the identity. It derives the same tool, connection, channel, or
  schedule name as a filesystem module; there is no redundant `name`, `kind`,
  slug, protocol, or precedence field.
- The default source ID is `<source.id>:<logicalPath>`. Source IDs are
  provenance, never provider discriminators or priority. Provider IDs and
  effective source IDs must be unique within a registry scope.
- `namespace` follows existing ESM selection semantics. `exportName` defaults
  to `default`, and the selected export may be a zero-argument sync or async
  factory.
- Construction shallow-copies and freezes source, module-array, and namespace
  containers. It never clones or deep-freezes definition values, preserving
  brands, symbols, functions, and non-enumerable durable callback metadata.
- The registry is explicitly assembled and imported. It is not global,
  side-effect-populated, or mutable after compilation begins.

`root` means the application root, not every subagent root. It may provide
root-owned definitions such as channels, schedules, and `agent.ts`.
`all-local-nodes` is a finite overlay applied after the filesystem and
extension node graph has been formed. It may provide node-owned tools,
connections, hooks, module instructions, module skills, and a sandbox. It
rejects `agent.ts`, `subagents/**`, `channels/**`, `schedules/**`, and
`extensions/**`, preventing recursive graph expansion. Existing local
subagents still receive eligible node defaults.

## Source graph and composition

Compilation needs an explicit backing binding for every effective module ref:

```ts
interface AgentModuleBinding {
  readonly logicalPath: string;
  readonly nodeScope: string;
  readonly sourceId: string;
  readonly provenance: {
    readonly layer: "framework-default" | "extension-package" | "consumer-override" | "application";
    readonly origin: "authored" | "framework";
  };
  readonly backing:
    | { readonly kind: "filesystem" }
    | {
        readonly kind: "programmatic";
        readonly moduleLogicalPath: string;
        readonly registrySourceId: string;
      };
}
```

The source graph pairs the discovered manifest with these bindings and a
namespace loader. The loader receives the node scope, source ref, selected
binding, external dependencies, and extension scope. Filesystem bindings call
the existing authored-module loader. Programmatic bindings load the exact
source/module pair from the registry. A missing programmatic binding is an
error and never falls back to a virtual path on disk.

Composition is independent of backing:

```text
root/local node: framework default < application source
extension mount: packaged contribution < consumer override
```

For each resource identity, the composer:

1. Classifies every candidate with the existing path grammar and rejects
   same-layer duplicates.
2. Chooses the higher-layer candidate before executing or normalizing either
   definition.
3. Normalizes only the winner through the existing per-primitive compiler. An
   invalid override fails instead of falling back to the shadowed default.
4. Accepts a disable sentinel only when a lower replaceable default exists,
   then retains disabled provenance while omitting that default.

This preserves cross-extension identity equivalence: `tools/bash.js` replaces
virtual `tools/bash.ts`, connection file and folder forms occupy the same slot,
and separately flattened duplicate tool names retain their current error.
Dynamic definitions are replaced at this source layer; names emitted later by
`defineDynamic` retain the current lifecycle precedence and collision rules.

Channel ordering also remains observable and exact. Surviving framework routes
stay in source-registration and route-declaration order, followed by filesystem
routes in discovery order. Identity replacement happens first, then first-wins
`(method, path)` deduplication. The winning route also owns CORS preflight. Host
registration and runtime dispatch must consume this identical ordered list.

The effective binding index is serialized into the existing versioned compile
metadata artifact and included in source-graph hashing; it does not introduce a
third runtime artifact or provider fields on definition records. Generated
module maps emit normal static imports for filesystem bindings and statically
reachable registry lookups for programmatic bindings. Authored-source hydration
loads the same index to choose the correct provider instead of reconstructing a
disk path from the manifest. On a cold process, the imported registry rebuilds
live namespaces before graph resolution, and a missing or mismatched binding
fails before any virtual disk access. The manifest remains strictly
serializable and contains no functions or provider branches.

## Framework migration

### Ordinary tools

Author `bash`, `read_file`, `write_file`, `todo`, and `web_fetch` once as public
`defineTool` values. Register those exact values at their canonical paths and
export them from `eve/tools/defaults`. Their executors receive ordinary
`ToolContext`; remove the internal-to-public converter, duplicate wrappers, and
the `sourceId.startsWith("eve:")` calling convention.

Register `webSearch({ provider: "exa" })` at `tools/web_search.ts`. An authored
`webSearch(...)`, `defineTool(...)`, or `disableTool()` at that identity then
composes normally; model-specific provider materialization remains a kernel
step. `glob` and `grep` remain opt-in exports rather than dormant defaults, so
disabling either without registering it remains an authoring error.

### `connection_search`

Register the existing public `defineDynamic` value at
`tools/connection_search.ts` for all local nodes. The compiler emits an ordinary
dynamic resolver, so the synthetic framework descriptor, special graph append,
and inspection branch disappear.

The feature body remains unchanged: it emits `connection_search` and discovered
`<connection>__<tool>` entries, preserves connection filtering, auth and
approval behavior, partial/all-failure handling, and
`ConnectionSearchResultsKey`. Because framework source does not pass through
the authored callback transform, it also retains the existing explicit
`stampDurableDynamicToolCallbacks` calls. The source layer adds no revision,
store, dispatcher, validation, or callback registry.

The canonical path intentionally changes the resolver slug from synthetic
`connection` to `connection_search` and gives it a derived source ID. Those are
inspection/provenance changes only: model-facing map keys and persisted callback
identity `(final tool name, phase)` do not change. Fresh processes reconstruct
the source and re-resolve step metadata before the existing lifecycle rebinds
persisted JSON closures to live callbacks.

### Framework channels

Register a root-only zero-argument factory returning
`eveChannel({ auth: [vercelOidc(), localDev(), placeholderAuth()] })` at
`channels/eve.ts`. A fresh value preserves the current resolver lifecycle. An
authored channel or `disableRoute()` at that identity replaces or removes the
whole nine-route default.

Register the callback handlers as six root-only, one-route `defineChannel`
factories:

- `channels/eve/v1/connections/callback/get.ts`;
- `channels/eve/v1/connections/callback/post.ts`;
- `channels/eve/v1/connections/callback/legacy/get.ts`;
- `channels/eve/v1/connections/callback/legacy/post.ts`;
- `channels/eve/v1/callback/post.ts`;
- `channels/eve/v1/task-input/post.ts`.

The identities remain independently replaceable and disableable. URLs,
legacy support, token-possession authorization, and response contracts remain
unchanged. The callbacks gain truthful `adapterKind: "http"` metadata and run
through the ordinary channel handler path, allowing removal of the narrower
framework-only `fetch` dispatch branch. Only the root manifest owns these
channels; no child node receives them or creates host routes.

The composed root manifest must exist before WebSocket detection, application
route registration, virtual handler/preflight generation, and development or
production route configuration. Those consumers stop importing framework
channel catalogs and use the compiled route list directly.

### Kernel capabilities

Some current tool names represent native harness behavior rather than an eve
tool primitive. Replace their fake resolved-definition catalog entries with a
typed inventory of replaceable default identities and behavior factories.

| Capability                | Prepared when                                  | Advertised when                                |
| ------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| `agent`                   | root node; not replaced or disabled            | top-level root session only                    |
| `task_cancel`             | tasks mode on the root node                    | top-level root session only                    |
| `task_update`             | tasks mode on the root node                    | delegated task child only                      |
| `ask_question`            | not replaced or disabled                       | session supports `requestInput`                |
| `load_skill`              | static skills or dynamic skill resolvers exist | the prepared node can load skills              |
| `web_search` materializer | effective source is the provider sentinel      | resolved model supports the configured backend |

Preparation is node-level, while advertisement is session/model-level. This
distinction is required because self-delegated children reuse the root node but
must not see root-only controls. `/info` can report build-level potential; it
cannot claim to be the exact tool set for every session and model call.

Every inventory entry has a canonical path for replacement and disable
validation. `agent` and task controls are shadowable by any final tool-namespace
occupant, including a local or remote subagent with that name. Other native
names are reserved, while an authored definition at their canonical identity
may still replace the native behavior. This per-entry policy replaces literal
name lists spread across graph, harness, prompt, and dispatch code.

The prepared inventory drives prompt flags, reservations, session filters,
runtime-action dispatch, harness construction, and build-level inspection. It
excludes opt-in `Workflow`, per-session `final_output`, and authored local or
remote delegation tools. Each native entry should become a programmatic eve
definition when a real durable task, client-input, or provider primitive can
express it.

## Inspection semantics

The effective compiled graph is the canonical inspection input: definition
facts come from the manifest, origin comes from the compile-metadata binding
index, and build-level native capabilities come from the typed kernel
inventory. Normalizers record safe facts that cannot be reconstructed from JSON
today, such as execution presence, approval, model-output projection, schemas,
execution mode, adapter kind, and route identity. They never serialize
callbacks. Tool `hasAuth` retains its current value (`false`): calls to
`ctx.getToken()` or `ctx.requireAuth()` occur inside arbitrary executor code and
cannot be inferred at compile time.

`/eve/v1/info` keeps its wire fields but changes their population:

- `available` contains active compiled `tools/**` definitions and prepared
  replaceable kernel defaults. It excludes local/remote delegation tools,
  `Workflow`, `final_output`, and dynamic outputs; session/model gating is not
  applied at this layer;
- `authored` contains active filesystem definitions;
- `framework` contains active programmatic definitions and prepared native
  capabilities; shadowed, disabled, and dormant opt-in rows are omitted;
- `disabledFramework` retains valid authored disable sentinels;
- `dynamic` contains active resolvers, including `connection_search`, not
  their session-specific outputs;
- `reserved` is derived from source and kernel policy rather than a literal
  list.

Framework rows that remain have active status; the existing replaced/disabled
row reconstruction is intentionally removed. This is a response-semantic
change despite retaining the field-level schema and requires documentation,
tests, and a minor changeset. One compiled-artifact projector becomes the sole
`/info` implementation; the parallel resolved-data approximation is removed.
Origin comes from composition provenance, never a source-ID prefix.

`eve info --json` and the Vercel agent summary keep their narrower existing
contracts. Within those contracts they consume the same effective compiled
manifest, so ordinary programmatic tools and active default/callback channels
now appear. They are not extended to report session-native capabilities,
dynamic outputs, or the full `/info` tool taxonomy in this change.

## Delivery

1. **Source-neutral loading.** Add bindings and a namespace-loader boundary,
   then route existing filesystem compilation and module-map creation through
   it, adding the binding index to versioned compile metadata without changing
   resolved behavior.
2. **Programmatic sources and tools.** Add validation, finite-scope
   composition, registry-backed module maps, and override/disable handling.
   Migrate ordinary tools and `connection_search`; replace tool metadata stubs
   with source entries or typed kernel entries.
3. **Channels and consumers.** Migrate the default and callback channels, make
   the effective manifest drive Nitro and inspection, then delete the old
   framework tool/channel catalogs and repeated merge paths.

Each stage remains buildable. The final change includes a minor changeset and
updates built-in tool, dynamic capability, channel, and inspection docs. A
public source API or virtual raw resources require separate API review and e2e
coverage.

## Validation

- Prove filesystem/programmatic parity for representative static and dynamic
  tools, connections, channels (including WebSocket and `receive`), schedules,
  sandboxes, module instructions, and module skills. Cover exports, factories,
  preserved brands/callback metadata, invalid paths, and duplicate identities.
- Cover composition across extensions and every existing local node: one-time
  qualification, higher-layer replacement/disable, finite node defaults, and
  root-only resources that never become child routes.
- Verify development, generated, bundled, and materialized module maps bind
  the same `(node, sourceId)` pairs, never import virtual disk paths, fail on a
  missing registry binding, and reconstruct live namespaces after a cold start.
  The persisted binding index must match every module-backed manifest ref and
  drive authored-source hydration and inspection provenance.
- Preserve the complete `connection_search` behavior suite, including long
  qualified names. Park an approval or authorization, restart the process, and
  complete the original call through the existing durable lifecycle.
- Assert the default eve channel's nine routes, order, auth chain, CORS, HTTP
  adapter, turn policy, and lack of `receive`/WebSocket. Cover whole-channel
  replacement/disable and a differently named route collision whose earlier
  winner owns both dispatch and preflight.
- Dispatch all six callback identities through the ordinary path and preserve
  exact statuses: connection `400`/`404`/successful `200` HTML, session
  `400`/`403`/`404`/`202`, and task input `400`/`403`/`404`/`202`. Replacing one
  must not remove its siblings.
- Exercise every kernel phase and audience, including dynamic-only skills,
  final-name shadowing, reservations, prompts, filters, dispatch, and the
  distinction between build potential and session advertisement.
- Verify `/info`, CLI JSON, Vercel summaries, and Nitro development/production
  routes follow their documented projections and share the same effective
  compiled resources. Run formatting, lint, typecheck, invariant guards,
  build, focused unit/integration/scenario tests, and existing fixture evals.

## Invariants and rejected alternatives

- Logical paths remain eve's only definition naming grammar; backing does not
  change normalization or runtime behavior.
- Programmatic construction is explicit, immutable, and complete before
  compile. There is no global registry, runtime mutation, function
  serialization, or generated temporary source.
- `defineDynamic` remains the ordinary lifecycle mechanism; no primitive gains
  a parallel dispatcher or durable store.
- Per-primitive registries and direct `Compiled*`/`Resolved*` construction are
  rejected because they duplicate identity, precedence, validation, and
  inspection semantics.
- A universal native-tool escape hatch is rejected. Capabilities that cannot
  yet be expressed honestly remain a small typed kernel boundary and move out
  as eve gains the necessary primitives.
