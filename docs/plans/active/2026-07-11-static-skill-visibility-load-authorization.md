# Static skill visibility and load authorization

## Concept

Add one Eve-owned `staticSkillVisibility` contract to the authored agent
definition. It resolves the compiled static skill names visible for a session or
turn, and the exact same resolved selection controls both the model's
`Available skills` announcement and framework `load_skill` authorization.

## Authority boundary

- The compiler remains authoritative for the complete, path-derived static
  skill inventory and materialized package resources.
- The authored agent's `staticSkillVisibility` resolver is the only runtime
  authority for which static names are visible in a session/turn.
- Eve runtime owns validation, durable context storage, prompt filtering, and
  framework-tool authorization. No Remi loader, semantic router, manifest
  patching, or alternate runtime is introduced.
- Dynamic skills remain additive and retain their existing resolver ownership,
  sandbox materialization, and collision rules.

## Public contract

`AgentDefinition.staticSkillVisibility` accepts Eve's dedicated
`defineStaticSkillVisibility({ events })` sentinel, which retains the same
event-handler ergonomics while giving this public slot an exact lifecycle
type. Its handlers may run only at `session.started` and `turn.started` and
return either:

- `"all"` — all compiled static skills;
- a readonly string array — exactly those compiled static skill names, including
  `[]` for none.

With no resolver, Eve preserves the current all-static behavior. A resolver
result containing an unknown static name, malformed value, unsupported event,
or thrown handler fails closed to an empty static selection for that boundary.
The selection is name-based, immutable, and session/turn scoped; it does not
move or delete package files.

## Owned files

Expected implementation and proof surface, narrowed from WS2 after checkout
inspection:

- Public/compiler contract: `packages/eve/src/public/definitions/agent.ts`,
  `packages/eve/src/public/index.ts`, `packages/eve/src/shared/agent-definition.ts`,
  `packages/eve/src/internal/authored-definition/core.ts`,
  `packages/eve/src/compiler/manifest.ts`,
  `packages/eve/src/compiler/normalize-agent-config.ts`, and module-map/runtime
  type seams as required by the compiled source reference.
- Runtime authority: `packages/eve/src/runtime/resolve-agent.ts`,
  `packages/eve/src/runtime/types.ts`,
  `packages/eve/src/runtime/agent/bootstrap.ts`,
  `packages/eve/src/context/keys.ts`, a focused static-visibility lifecycle
  module, `packages/eve/src/execution/workflow-steps.ts`,
  `packages/eve/src/execution/session.ts`, and
  `packages/eve/src/runtime/framework-tools/skill.ts`.
- Focused tests adjacent to compiler normalization, lifecycle/context,
  session/prompt, framework skill authorization, workspace resource
  materialization, and replay serialization.
- One patch changeset for the published `eve` package.

## Replay and cache semantics

The resolved selection is stored in a registered serializable context key.
`session.started` establishes the session value once; `turn.started` replaces
the turn value before the model call. The current context selection survives
workflow step boundaries and durable replay, while the resolver is re-evaluated
only on its declared lifecycle events. Continuation steps within a turn reuse
the same selection. Prompt refresh uses the selection before composing the
static skill block, and dynamic announcements remain additive after it.

Changing the selection changes the system-prompt prefix intentionally, so Eve's
existing prompt-cache breakpoints treat it as a new prompt variant; an
unchanged selection keeps the normal cache path. Materialized static packages
and sibling files remain present regardless of visibility, and replay does not
re-materialize or delete them.

## Proof contract

Focused tests must cover all, subset, empty, unknown-id fail-closed, direct
hidden-name rejection, selected packaged sibling-file access, dynamic plus
static visibility, static/dynamic name collision behavior, next-turn
re-resolution, context replay, prompt filtering, and no-resolver compatibility.
Then run the Eve typecheck and full suite using repository-prescribed tier
configs, plus `pnpm diff:check`/the repository's equivalent diff hygiene check,
and self-review the exact diff for authority leakage or scope expansion.

## Release path and cleanup

This PR targets upstream Eve `main` as one ready PR. Because the upstream
repository is read-only for the current GitHub identity, push the branch to an
available fork and open one ready cross-repository PR against `vercel/eve:main`
if fork publication is available. Do not merge, self-approve, publish a
package, update Linear, or open a second PR. After the upstream merge, release
the published `eve` package with the changeset, then Remi may update its Eve
dependency. No compatibility shim, category router, post-tool navigation,
custom loader, manifest patch, sibling runtime, or package release is included
in this change.
