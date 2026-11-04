---
issue: TBD
status: implemented
last_updated: "2026-10-27"
---

# Build-time model metadata

## Decision

Model metadata belongs to a deployment, not to a session. eve reads the AI Gateway model
catalog once per build, ships a snapshot with the compiled artifacts, and resolves every
runtime model selection from that snapshot. The runtime never requests the catalog.

This replaces the runtime catalog client that dynamic models introduced
([dynamic agent configuration](./dynamic-agent-configuration.md)). That client fetched
the full catalog (about 450 models, 175 KB) on the first selection of each new session and
on every `ctx.agent(name, { model })` call, made dynamic-model turns depend on AI Gateway
availability, and cached results in durable session state.

## What eve needs

The only runtime consumer of model metadata is compaction, which needs the selected model's
context window. A catalog match also gives a direct provider model, such as
`anthropic("claude-sonnet-5")`, its Gateway slug for display and tracing. eve records nothing
else; `maxOutputTokens` is not part of a model reference.

## Lifecycle

```text
eve build / eve dev
  compile ──reads──▶ AI Gateway catalog (5-minute disk cache, stale on error)
     │                 └─ resolves static model and compaction windows into the manifest
     └─writes──▶ .eve/compile/model-metadata.json (trimmed snapshot)
                  └─ embedded in the production bootstrap

runtime
  dynamic model · dynamic subagent config · ctx.agent model override
     └─▶ explicit modelContextWindowTokens ─▶ build snapshot ─▶ actionable error
```

The snapshot keeps each model's slug and the providers that publish a positive context
window, about 80 KB of compact JSON for 326 models. The runtime reads it at most once per
compiled bundle.

## Semantics

- An explicit `modelContextWindowTokens` wins, and eve reads no metadata.
- A Gateway model id keeps its authored id, including a `-thinking` variant, and takes the
  window of its catalog entry, as the compiler does for a static model.
- A direct provider model takes its catalog slug when the snapshot lists it.
- A model the snapshot does not list fails the selection with
  `InvalidRuntimeModelSelectionError`. The message names the catalog read time, or says the
  build could not read the catalog, and tells the author to return
  `modelContextWindowTokens` or rebuild.
- A build that cannot read the catalog and has no cached copy still compiles when no static
  model needs a lookup. It ships an empty snapshot and reports the
  `compile/model-metadata-unavailable` warning.

Resolved references still record their context window, so a session or child workflow
replays the same selection after a redeploy changes the snapshot.

## Invariants

- No runtime path requests the AI Gateway catalog.
- One set of lookup functions serves the compiler and the runtime.
- The snapshot is deployment data, not durable session state.
