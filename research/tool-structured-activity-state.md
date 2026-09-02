---
issue: https://app.notion.com/p/vercel/9-1-26-Activity-rendering-overview-3cfe06b059c4814f8625e5238264af9b
status: implemented
last_updated: "2026-09-02"
---

# Project structured tool state into activity

> **AI status:** Written entirely by AI; human review pending.

## Strategy

Tools sometimes produce model-authored state that a channel may want to render separately from the action lifecycle. The built-in `todo` tool is one example, but plans are not a framework-level activity concept: an authored tool may expose a different planning schema or an unrelated stateful artifact.

Add an explicit tool projection that maps successful output to bounded JSON under a renderer-owned key:

```ts
export default defineTool({
  // description, schemas, and execute omitted
  activity: {
    label: () => "Update project plan",
    state: {
      key: "project-plan",
      project: (output) => output.tasks,
    },
  },
});
```

The data path remains a projection of the durable session event log:

```text
model tool call
  -> validated tool execution
  -> durable action.result
  -> authored state projection
  -> internal state.replaced activity event
  -> activity snapshot.states[key]
  -> channel renderer
```

`action.result` remains the source event. `state.replaced` is internal reducer input rather than a new public session event or duplicated result payload.

## Semantics

- The state key identifies a contract between the tool and renderer. eve does not assign meaning to keys or inspect projected schemas.
- A successful final result replaces the previous value for `(owning work, key)`. Failed and rejected calls do not change state.
- The snapshot records the projected value with its source tool, action, event, owning work, root turn, and replacement time.
- A renderer receives every work-scoped publication and ignores keys it does not understand. It may show only root state, nest state under its owning work, or flatten publications that share a key. Multiple renderers may interpret the same state differently.
- Custom tools can use their own keys and schemas. Tools may share a key only when they intentionally implement the same renderer contract.
- Structured state is separate from observed `work`, `actions`, and `blockers`. A renderer may combine them visually, but eve infers no ownership relation beyond the recorded source action and work.

## Boundaries

Projection is opt-in. Automatically forwarding tool results would disclose values that were not authored for presentation and could impose unbounded work on the collector or provider renderer. Projected values must therefore be JSON-serializable and pass explicit byte, depth, and entry limits before they enter the activity protocol.

Projection callbacks follow the existing activity failure boundary: an invalid key, callback exception, non-JSON result, or over-limit value drops the state update without changing tool execution, model output, or final-response delivery.

The collector uses replacement time and source event identity to converge duplicate or out-of-order deliveries. Activity remains best-effort presentation; the public event stream remains the durable record available for replay and inspection.

## Built-in `todo`

The built-in `todo` tool adopts the same authored surface as any other tool and projects its current item list under the `todo` key. Root and nested subagent todo lists remain separate publications; a Slack or other channel renderer decides whether to show the root list, render one list per work item, or combine them. This exposes todo status without adding a `plan` lane or todo-specific parsing to the activity protocol.
