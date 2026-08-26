---
status: proposed
last_updated: "2026-08-26"
---

# Sibling subagents: mount a top-level agent as a subagent

## Decision

Add a public `defineSiblingSubagent(config, overrides?)` sentinel that lets a
single-file subagent mount a _complete_ top-level agent — instructions, tools,
hooks, skills, connections, sandbox, and nested subagents — by importing its
`agent.ts`:

```ts
// triage/agent/subagents/reviewer.ts
import { defineSiblingSubagent } from "eve";
import reviewer from "#agents/reviewer/agent.ts";

export default defineSiblingSubagent(reviewer, {
  description: "Delegate code reviews here.",
});
```

Discovery statically resolves the import specifier to the sibling agent's
directory and runs full agent-package discovery against that root, producing a
normal `LocalSubagentSourceRef` whose manifest points at the sibling. The
compiler and runtime need almost no changes because every downstream consumer
already resolves resources against `manifest.agentRoot`, not against the
parent's `subagents/` directory.

## Problem

There is no way to reuse a top-level agent as a subagent without losing its
resources.

- `defineAgent` is an identity function
  (`packages/eve/src/public/definitions/agent.ts:106`), so a subagent file
  _can_ import and re-export a sibling's config value. But an agent's identity
  is mostly its **directory**: `instructions.md`, `tools/`, `hooks/`,
  `skills/`, `sandbox/`, and nested `subagents/` are discovered from the
  filesystem, not carried by the config value. A single-file subagent gets a
  manifest containing _only_ the config module
  (`packages/eve/src/discover/discover-subagent.ts:158`), so the import shares
  model/reasoning/limits but silently drops everything else.
- `defineRemoteAgent` gets full fidelity but requires a separate deployment
  and a network hop.
- Extracting a factory package shares logic but duplicates directory
  scaffolding at every mount point and cannot share filesystem-discovered
  resources at all.

A name-based agent registry (`defineAgentConnection`) was discussed previously
and deferred.

## Authoring API

New export from `eve`:

```ts
interface SiblingSubagentOverrides {
  /**
   * Required in practice: root agents rarely author `description`, and
   * subagent compilation fails without one. Also lets the parent frame
   * delegation in its own terms.
   */
  readonly description?: string;
  // Later: model/reasoning/limits overrides, tool allowlists, etc.
}

export function defineSiblingSubagent(
  config: AgentDefinition,
  overrides?: SiblingSubagentOverrides,
): SiblingSubagentSentinel;
```

The returned sentinel is a tagged value
(`{ kind: "sibling-subagent", definition, overrides }`) analogous to the
existing dynamic sentinel. The `config` argument is not dead weight: the
compiler imports the mount module as it does any subagent config module and
uses the carried definition as the node's compiled agent config, merged with
`overrides`.

## Design

### Why the value alone is not enough — and how discovery still works

By the time `defineSiblingSubagent(reviewer)` executes, `reviewer` is a plain
object with no filesystem provenance. Extension mounts already solved this
exact problem: discovery **statically parses the mount file's source text** to
extract the import specifier that binds the re-exported value, without
importing authored code
(`parseExtensionMountSpecifier`,
`packages/eve/src/discover/extension-specifier.ts:19`, used by
`locateExtensionMountPackage`,
`packages/eve/src/discover/extensions.ts`), honoring the "never import
authored modules" discovery invariant.

`defineSiblingSubagent` reuses that mechanism. Discovery:

1. Reads the mount file text (`subagents/reviewer.ts`).
2. Detects the sibling shape: `export default defineSiblingSubagent(<ident>, …)`
   where `<ident>` is bound by an import.
3. Extracts the specifier (`#agents/reviewer/agent.ts`) and resolves it:
   - relative specifiers against the mount file's directory,
   - `#…` specifiers via the nearest `package.json` `imports` map (readable
     statically),
   - bare specifiers via package resolution (same as extension mounts).
4. Takes `dirname(resolvedModule)` as the **sibling agent root**.
5. Runs the existing local-subagent package discovery
   (`discoverLocalSubagentPackage`,
   `packages/eve/src/discover/discover-subagent.ts:184`) against that root,
   producing a `LocalSubagentSourceRef` whose `manifest.agentRoot` is the
   sibling directory.

The subagent's parent-visible name still derives from the mount filename
(`reviewer.ts` → `reviewer`), preserving the existing "name = path under
`subagents/`" rule and letting one sibling be mounted under different names by
different parents.

### Why downstream mostly already works

`LocalSubagentSourceRef.manifest` carries an absolute `agentRoot`
(`packages/eve/src/discover/manifest.ts:76`), and resource compilation
resolves against `manifest.agentRoot` rather than assuming resources live
under the parent (see the `input.manifest.agentRoot` call sites in
`packages/eve/src/compiler/normalize-manifest.ts`; per-subagent roots already
flow through the module map, `packages/eve/src/compiler/module-map.ts`). A
manifest rooted at a sibling directory compiles through the existing pipeline.
The recursive subagent graph also composes: the sibling's own `subagents/` are
discovered and compiled as grandchildren for free.

### Root-vs-subagent grammar policy

The sibling directory is authored as a _root_ agent, so it may legally contain
things a subagent may not. Per-slot policy:

| Slot                                                                                                           | Policy when mounted as sibling subagent                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `instructions`, `tools/`, `hooks/`, `skills/`, `lib/`, `connections/`, `sandbox/`, `subagents/`, `extensions/` | Mounted as-is (existing subagent semantics)                                                                                                                                                      |
| `channels/`                                                                                                    | Ignored with an info diagnostic — channels belong to the deployment that owns the HTTP surface                                                                                                   |
| `schedules/`                                                                                                   | Ignored with an info diagnostic (subagent packages reject schedules today, `packages/eve/src/discover/discover-subagent.ts:360`; ignore rather than error so one directory can serve both roles) |
| `experimental.workflow` / `experimental.tasks` in config                                                       | Hard error, unchanged (`packages/eve/src/compiler/normalize-manifest-helpers.ts:34`)                                                                                                             |
| Missing `description` after overrides merge                                                                    | Hard error, unchanged (`expectSubagentDescription`, `packages/eve/src/compiler/normalize-manifest-helpers.ts:112`)                                                                               |

### Cycle detection

Sibling mounts introduce potential cycles (triage mounts reviewer; reviewer
mounts triage). Discovery recursion threads a visited set of canonical
(realpath'd) agent roots; revisiting a root emits an error diagnostic naming
the cycle path.

### Static-parse fragility boundary

Like extension mounts, the mount file must match a recognized shape.
`defineSiblingSubagent(makeReviewer())`, aliasing through intermediate
variables, or re-export chains will not statically resolve. This constraint
already exists for extension mounts; the requirement is that a non-resolvable
`defineSiblingSubagent` call **fails loudly** with a discovery diagnostic
("could not statically resolve the sibling agent source") instead of silently
compiling a resource-less subagent.

### Dev server and packaging

- **Watching:** the dev server must add resolved sibling roots to its watch
  set; today watch roots derive from the app root only.
- **Bundling:** sibling sources become build inputs. This mostly falls out of
  the manifest (module map entries already carry per-subagent `agentRoot`),
  but build fingerprinting/caching must include sibling directories.
- **`externalDependencies`:** inherited through the existing merge chain; the
  sibling's own `build.externalDependencies` participate as they do for any
  subagent.

## Semantics: embedding, not sharing

A sibling mount is compiled **into the parent's deployment** — its own runtime
node, sessions, and state, baked at build time. The standalone reviewer
deployment (if one exists) is a different running agent:

- Change reviewer + redeploy only reviewer → triage's embedded copy is stale
  until triage rebuilds.
- Reviewer state (sessions, durable state) is per-deployment; the embedded
  copy and the standalone copy do not share it.

If one live reviewer shared across parents is the requirement, that is
`defineRemoteAgent`, not this proposal. The two compose: a team can start with
sibling mounts in a monorepo and later swap a mount file to a remote agent
without touching the parent's delegation behavior.

## Alternatives considered

1. **`defineSubagent(reviewerConfig)` (value only, no static resolution).**
   Loses all filesystem resources; rejected as silently lossy.
2. **Explicit thunk: `defineSubagent({ source: () => import("…") })`.**
   Same static-parse requirement dressed as runtime API; the import-the-config
   form is strictly better because the compiler actually uses the value.
3. **Symlinks under `subagents/`.** Discovery's `entry.isDirectory()` checks
   and logical-path derivation make this fragile and platform-dependent; also
   invisible in code review.
4. **Name-based agent registry (`defineAgentConnection`).** Previously
   discussed and deferred; heavier surface (naming, versioning, resolution
   order) than a file-anchored mount.
5. **Extension mounts.** Extensions deliberately cannot carry `agent.ts` or a
   sandbox (`packages/eve/src/discover/discover-agent.ts:182`) — they
   contribute capabilities, not agent identity. Wrong primitive for "run this
   whole agent as my delegate."

## Open questions

1. **Export location:** `eve` root export vs. an `eve/subagents` subpath.
2. **Override surface at v1:** `description` only, or also
   `model`/`reasoning`/`limits`? Minimal (`description`) is proposed;
   everything else can be added additively.
3. **Directory-form mounts:** should `subagents/reviewer/agent.ts` also be
   allowed to contain a sibling mount (enabling co-located override files), or
   is the single-file form sufficient for v1? Proposed: single-file only.
4. **Diagnostics for dual-role directories:** when the same directory is both
   deployed standalone and mounted as a sibling, should eve surface a build
   note about the embedding-not-sharing semantics?
5. **Workspace layout:** the motivating layout
   (`$workspaceroot/<agent>/…` with `#agents/*` imports-map aliases) implies
   multiple eve apps in one workspace. Does the CLI need any awareness
   (e.g. `eve dev` at the workspace root), or is per-app invocation fine?
