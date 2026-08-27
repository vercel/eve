---
issue: https://github.com/vercel/eve/issues/905
status: implemented
last_updated: "2026-08-25"
---

# Tool output overflow

## Summary

A single tool result can consume most of a model context window before
compaction can act. Authored tools can reduce their own output with
`toModelOutput`, but generated connection tools and other runtime-owned paths
do not share an author-controlled projection hook.

Add one opt-in agent policy that moves oversized model-facing tool results to
the session sandbox. Keep the full execution result on `action.result`; store
only the bounded file reference in model history.

## Authoring API

```ts
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
  toolOutput: {
    maxInlineBytes: 64 * 1024,
    overflow: "sandbox",
  },
});
```

Both fields are required. Omitting `toolOutput` preserves existing behavior.
The only supported overflow strategy is `"sandbox"`.

## Semantics

The policy runs at the common model-history boundary after runtime action
resolution and `action.result` emission have preserved the full output, but
before compaction and the next model request.

For each eve-controlled `tool-result`:

- text is measured in UTF-8 bytes;
- JSON is measured using its compact serialization;
- results at or below `maxInlineBytes` remain unchanged;
- larger text and JSON values are written as `.txt` and readable `.json` files
  under `/workspace/.eve/tool-results`;
- model history receives `{ kind, path, bytes, toolName }` as a JSON tool
  result, tagged with `kind: "eve-tool-output-file"`.

The filename derives deterministically from the tool call id and serialized
output. Replaying the same call with the same output reuses its path; a changed
output receives a different path. Existing eve file references are not
projected again.

After a sandbox write succeeds, eve emits `tool.output.spilled` with the call
and tool identity, byte count, configured limit, path, and a deterministic
`spillId` derived from the same digest as the file path. The event is durable
and available to hooks, channels, and stream clients. Instrumentation projects
the same bounded metadata onto an `agent.tool.output` span without recording
the full body.

Within a committed session, the stored reference prevents a later projection
from emitting again. A durable-step retry can still physically repeat the
event because event-stream writes and the returned session checkpoint are not
one transaction. Consumers and trace backends use `spillId` as the logical
idempotency key.

Framework control results that later steps must parse from history remain
inline. `connection_search` is the initial protected control tool because its
results reconstruct discovered connection tools. Approval denials also remain
inline.

## Boundaries

The policy covers authored tools, framework tools, discovered connection
tools, client-supplied tools, runtime-action results, and subagent or task
results that eve places in model history or runtime-authored task context.
Explicit `toModelOutput` projections run first and remain the preferred way to
provide a semantic summary.

Provider-executed server tools are outside the first-call boundary because the
provider consumes their output before eve receives it. Sandbox storage is
session-scoped, not external artifact storage; provider-side physical sandbox
replacement may lose files created after sandbox initialization.

## Verification

- Public config normalization and compiled-manifest propagation.
- Small-result passthrough and oversized text/JSON projection.
- Discovered MCP-shaped output, deterministic replay paths, protected control
  output, and reference idempotence.
- Full `action.result` emission, durable `tool.output.spilled` notification,
  bounded trace metadata, a referenced first checkpoint, and the same reference
  on the next model call.
