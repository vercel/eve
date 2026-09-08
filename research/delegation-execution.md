---
issue: "No issue filed; local implementation proposal"
status: in-progress
last_updated: "2026-09-08"
---

# Per-call delegation execution

One general worker should support inexpensive extraction and deeper investigation
without separate domain agents or a replacement task scheduler.

```ts
// subagents/worker/agent.ts
export default defineAgent({
  description: "Complete a bounded assignment in the shared workspace.",
  model: "openai/gpt-5.5",
  delegationModels: ["openai/gpt-5.5", "google/gemini-2.5-flash"],
  limits: { maxTokenCostUsdPerSession: 2 },
});

worker({
  message: "Read the assigned source files and save the findings.",
  execution: { model: "google/gemini-2.5-flash", maxCostUsd: 0.25 },
});
```

The field is opt-in and local-delegate-only. Calls without overrides retain their
configuration. Resume calls cannot supply overrides. Model IDs are allowlisted;
reasoning uses the existing provider-agnostic vocabulary. Provider support still
requires validation. Explicit cost is a lower ceiling alongside inherited and
authored limits, not an allocation increase or an atomic tree-wide reservation.

The native workflow invocation carries execution settings to dispatch planning.
The selected durable model reference becomes the child runtime configuration,
preserving sandbox, tools, approvals, history and native completion reporting.
No model options are inferred from prompt text. Dynamic default models are not
supported in the initial opt-in surface.

Verification must cover compiler round-trip, fresh selection, invalid options,
budget clamping, continuation, native workflow transport and actual child model
calls before integration. The application using it is intentionally separate from
the earlier Signals agent and must import no implementation from that agent.
