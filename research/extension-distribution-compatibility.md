---
issue: TBD
last_updated: "2026-07-17"
status: proposed
---

# Extension distribution and compatibility

## Summary

eve extensions should publish a built, agent-shaped distribution tree while the consuming
application's eve remains responsible for discovery, validation, normalization, namespacing, and
final bundling. The npm package need not contain the author's original TypeScript, but it does not
ship eve-internal compiled definitions either. This is a **source-backed execution contract with a
dist-only publication contract**.

Compatibility is independent of eve's package version. `eve extension build` generates a small
manifest containing only the extension capabilities the package uses and the contract version it
requires for each one. A skills contract change therefore cannot invalidate a tools-only
extension. npm provides the consumer's singleton eve through a required wildcard peer; eve itself
performs compatibility validation from the generated manifest.

Local workspace extensions use the same dist tree as published packages. `eve dev` watches their
real source roots, rebuilds affected extension dist trees transactionally, then reuses the existing
agent-generation reload path. Development therefore exercises the package that will be published
without requiring a second source-resolution mode.

## Package contract

An extension has distinct authoring and distribution roots:

```jsonc
{
  "name": "@acme/crm",
  "type": "module",
  "files": ["dist"],
  "eve": {
    "extension": {
      "source": "./extension",
      "dist": "./dist/extension",
    },
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.mjs",
    },
    "./tools": {
      "types": "./dist/tools/index.d.ts",
      "default": "./dist/tools/index.mjs",
    },
  },
  "peerDependencies": {
    "eve": "*",
  },
  "devDependencies": {
    "eve": "^0.24.6",
  },
}
```

`source` is build input and is not published by default. `dist` is the only tree a consuming app
mounts. `eve extension build` owns the managed exports and emits:

```text
dist/
  extension/
    _manifest.json
    extension.mjs
    tools/search.mjs
    skills/triage/SKILL.md
    lib/client.mjs
  index.mjs
  index.d.ts
  tools/index.mjs
  tools/index.d.ts
```

The build transforms JavaScript and TypeScript modules individually while preserving their logical
paths and relative module graph. Markdown, skill packages, scripts, references, and assets are
copied without changing their semantics. Generated entrypoints re-export modules from the dist
tree so the mount, consumer overrides, and compiled agent share the same module identities. Publish
artifacts do not embed source maps containing the author's source text.

The consuming eve walks `dist`, loads its public definitions through the consumer's `eve/*`
exports, and produces the consuming agent's internal compiled manifest. Internal types such as
`CompiledToolDefinition` are never a package-level extension ABI.

## Dependency semantics

`eve` is a required peer with the wildcard range. The peer exists to make package managers resolve
extension imports against the application's singleton eve; it does not express extension
compatibility. `peerDependenciesMeta.eve.optional` is deliberately absent because an extension
cannot operate without eve. The application should declare eve directly, while the extension's
concrete dev dependency provides authoring types and build tooling.

Everything the distributed extension imports at execution time belongs in `dependencies`.
Build-only and test-only packages belong in `devDependencies`. A package that must share the
consumer's instance may be a peer, and an integration that is genuinely optional may use optional
peer metadata. An extension must never carry its own runtime `eve` dependency.

The wildcard peer keeps npm semver out of capability compatibility for stable eve releases. Strict
install tests must also cover eve prereleases. If package managers cannot represent the supported
prerelease policy without warnings, the fallback is to remove the peer and make the eve compiler
alias extension `eve/*` imports explicitly; marking the peer optional does not solve a present-peer
version mismatch.

## Generated compatibility manifest

`dist/extension/_manifest.json` is generated and validated as data:

```json
{
  "kind": "eve-extension",
  "formatVersion": 1,
  "builtWithEve": "0.24.6",
  "requires": {
    "extension": 1,
    "tool": 1,
    "config": 1
  }
}
```

The fields have separate meanings:

- `formatVersion` versions this JSON schema, not extension behavior.
- `builtWithEve` is diagnostic information only.
- `requires` contains only extension-facing contracts used by this package.

The initial capability vocabulary is `extension`, `tool`, `dynamicTool`, `connection`, `hook`,
`skill`, `dynamicSkill`, `instructions`, `dynamicInstructions`, `config`, and `state`.
`extension` is the small universal mount, module-loading, and filesystem contract. Other
capabilities remain independent unless their semantics truly share a contract.

The build derives requirements rather than asking authors to maintain them:

- Static and dynamic slot files require their matching capability.
- Declaring a config schema requires `config`; a no-config declaration does not.
- Importing and using `defineState` requires `state`; it is not stamped on every extension.
- Capability dependencies are expanded, such as `dynamicTool` requiring `tool` and
  `dynamicSkill` requiring `skill`.
- Every extension requires `extension`.

The manifest may gain a file inventory later if it materially improves discovery, but the
filesystem remains authoritative in the first version. It does not serialize schemas, normalized
definitions, executable functions, or other compiler output.

## Capability version semantics

Each eve release declares all capability versions it can consume, not just one current value:

```ts
const EXTENSION_CAPABILITY_SUPPORT = {
  extension: [1],
  tool: [1, 2],
  skill: [2],
  config: [1],
  state: [1],
} as const;
```

Consumer validation checks only keys present in the extension's `requires` map and succeeds when
the required version appears in the consumer's supported set. Unknown capability names and unknown
versions fail closed before any extension module executes.

A capability version advances when a newly built extension can require behavior an older consumer
cannot interpret. A newer eve should retain older versions through an adapter whenever practical.
If an incompatible change cannot be adapted, the new eve drops the old version from its supported
set; only extensions using that capability become incompatible. Changes outside extension-facing
contracts do not alter any capability version.

Examples:

- A skills-only contract change advances `skill`; a tools-only extension remains valid.
- A new tool feature advances `tool` to 2. A newer eve can support `[1, 2]`, keeping existing tool
  extensions valid while rejecting tool-v2 extensions on older consumers.
- A state scoping change advances `state` without affecting extensions that do not call
  `defineState`.
- A universal change to mounting or path interpretation advances `extension`; this should be rare.

Compatibility errors name the extension package, capability, required version, supported versions,
and an actionable upgrade or downgrade:

```text
Extension "@acme/crm" requires tool contract v2, but this eve supports tool contract v1.
Upgrade eve or install an extension release that requires tool v1.
```

## Consumer lifecycle

For an installed extension, agent compilation proceeds in this order:

1. Resolve the mount package and its package root without executing the mount.
2. Read `package.json#eve.extension.dist` and the generated manifest.
3. Validate the manifest format and each required capability.
4. Discover the agent-shaped dist tree and compose its contributions under the mount namespace.
5. Evaluate the consumer's mount module to bind extension config.
6. Normalize extension definitions with the consuming eve and include their modules in the final
   agent bundle.

Missing, malformed, or incompatible manifests fail the build before extension code runs. There is
no fallback to author source for an installed package and no fallback to a legacy compiled
artifact. Local and registry packages therefore have the same consumer semantics.

### Namespacing and overrides

Distribution does not change composition. Modules in `dist/extension` retain their bare,
path-derived names; the consumer's mount path still supplies the namespace (`crm` + `search` →
`crm__search`). Directory overrides under `agent/extensions/crm/` compose into that same namespace
and win on collision, while `disableTool()` removes the matching extension tool. The generated
`@acme/crm/tools` barrel re-exports the exact dist modules discovery consumes so overrides and
runtime helpers share module identity.

Config and durable state remain scoped to the extension package name, separately from the mount
namespace. Renaming a consumer mount therefore changes model-facing contribution names without
orphaning package state. The compatibility manifest only gates contracts; it does not participate
in naming, merge precedence, or disable behavior.

## Workspace development and HMR

Workspace development keeps the published dist contract and automates its producer step. A local
extension is one whose resolved package root realpaths into the application's workspace source
root; detection is based on the filesystem rather than `workspace:` syntax so linked and `file:`
packages behave consistently.

At `eve dev` startup:

1. Resolve mounted packages far enough to read their source/dist roots.
2. Identify local extensions and build them before the initial agent compile.
3. Record each canonical source root and its build configuration.
4. Add those source roots to the authored-source watcher.

When a watched extension source changes:

```text
extension source change
        |
        v
build affected dist tree in a temporary location
        |
        v
atomically replace the managed dist tree
        |
        v
prepare and compile the next agent generation
        |
        v
activate it through the existing transactional reload
```

Only affected extensions rebuild. Added and removed contributions cleanly add or remove dist
outputs; edits to skills and assets recopy their content. Generated `dist` paths remain ignored by
the source watcher, preventing rebuild loops. A failed extension build leaves both its previous
dist tree and the currently serving agent generation intact. Changes to an extension's local
workspace dependencies still trigger an agent rebuild through the existing transitive workspace
watch plan; the extension itself only needs rebuilding when its managed source tree changes.

This is an eve development reload rather than browser-style component HMR: the server remains
available while eve builds and atomically activates a new immutable agent generation. Directly
resolving workspace TypeScript through a development-only export condition is intentionally
avoided because it would give local extensions different entrypoints, barrels, and module identity
from their published packages.

## Build and runtime invariants

- Published extensions contain the dist tree and generated manifest; original TypeScript is not
  required.
- The consumer, not the extension author, owns normalization into eve's internal compiled model.
- npm peer ranges never decide capability compatibility.
- Only used capabilities can invalidate an extension.
- Extension capability validation completes before authored extension code executes.
- Extension entrypoints and tool barrels re-export the same dist modules discovery consumes.
- Workspace HMR builds the same dist contract registry consumers install.
- Failed development rebuilds never replace a valid dist tree or live generation.

## Migration from the contribution artifact

The producer-side contribution manifest on the current branch should become the compatibility
manifest described here:

- Retain versioned parsing, serialization, `builtWithEve`, and the capability vocabulary.
- Add the universal `extension` capability.
- Replace exact current-version comparison with supported-version membership.
- Stop stamping `config` and `state` unconditionally.
- Remove serialized compiled contributions and the compiler schemas they expose.
- Keep source compilation and namespacing on the existing consumer path.
- Change the scaffold to distinct source/dist roots, `files: ["dist"]`, and a required wildcard eve
  peer.
- Replace discovery's `peerDependencies.eve` compatibility check with manifest capability
  validation.
- Extend `eve dev` to prebuild and transactionally rebuild local mounted extensions.

A genuinely pre-normalized extension may be designed later as a separate artifact kind with an
explicit ABI. It is not a fallback or alternate interpretation of this manifest.

## Verification

Use the narrowest test tier for each contract:

- Unit: manifest schema, unknown capability rejection, supported-version membership, capability
  dependency expansion, and config/state usage detection.
- Integration: extension build emits a complete dist tree and manifest; entrypoints reference dist
  modules; consumer discovery ignores author source; unrelated capability changes remain valid.
- Scenario: a mounted workspace extension hot-reloads edits, additions, removals, config, skills,
  and assets; failed builds preserve the prior generation; generated dist writes do not loop.
- Package-manager fixtures: packed extensions install under npm `--strict-peer-deps`, strict pnpm,
  and Yarn with multiple stable and prerelease eve versions, without acquiring a private eve copy.
- E2E: registry-installed extension fixtures publish dist only and continue to boot, accept a
  request, and execute namespaced tools in CI.

The implementation changes the published `eve` package and requires a patch changeset. Public docs
must describe the source/dist split, capability diagnostics, required wildcard peer, and automatic
workspace development behavior.

## Open issue

File a tracking issue and replace the frontmatter placeholder before landing.
