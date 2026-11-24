---
issue: https://github.com/vercel/eve/pull/6809
status: implemented
last_updated: "2026-11-24"
---

# Extraction models in eve

## Recommendation

Expose standalone `extract` from `eve/ai`, beside `decide`, and build it on AI
SDK's `experimental_extract` (`ai@7.0.176`). AI Gateway serves extraction
models such as ScaleDown Extract-1 (`scaledown/extract-1`). An extraction model
reads typed values out of shared state and reports confidence and the source of
each value.

`extract` follows `decide`'s boundaries:

- eve-owned public types (`ExtractionModel`, `ExtractionState`,
  `ExtractionField`, `ExtractionAnswer`, `ExtractionResult`, and their parts),
  so the declarations don't change with the app's AI SDK version;
- the same option style: `model`, `state`, `fields`, `referenceDate`,
  `maxRetries`, `signal`, and `providerOptions`, returning only `answers` and
  normalized `usage`;
- the same model resolution: a configured `AI_SDK_DEFAULT_PROVIDER`, the
  `/login` Gateway connection during `eve dev`, and otherwise AI SDK's Gateway;
  provider instances keep their own authentication;
- usage recorded on the active session as kind `extraction`.

```ts
import { extract } from "eve/ai";

const result = await extract({
  model: "scaledown/extract-1",
  state: "Invoice INV-2041 from Acme Corp. Contacts: Ana, Bo.",
  fields: {
    invoiceNumber: { type: "text", instructions: "The invoice number" },
    contacts: { type: "list", items: "text", instructions: "Contact names" },
  },
});
result.answers.invoiceNumber.value; // "INV-2041" | null
```

## Decisions

- **No default model.** `decide` defaults to Jev, but one vendor's model is
  the only extraction model today. `model` is required and a missing model
  throws before any provider call.
- **Full answers.** Answers expose `value`, `guess`, `pNull`, `confidence`,
  `source`, and per-item list entries unchanged from AI SDK. Confidence and
  source offsets are what callers use to route uncertain values to review.
- **Extraction names.** State, input, and field types have their own
  `Extraction*` names instead of reusing `Decision*` types, so extraction code
  reads on its own.
- **Excluded options.** `maxOutputTokens`, `reasoning`, `headers`, and
  `experimental_download` stay out, as they do for `decide`. File parts given
  as URLs therefore fail; callers pass file contents.

## Tracing

AI SDK `extract` has no telemetry hook, so eve traces the call itself. A new
`extraction <model>` span kind in `@vercel/agent-runs` (`AgentRun.extraction`)
nests like a decision span: under the active tool or turn, with model, usage,
Gateway cost, and response attributes. Per-field results are output content,
recorded as `gen_ai.extraction.results` only when the capture records outputs.
A refusal (`ExtractionRefusalError`) is a result, not a failure. `decide` and
`extract` share the code that resolves trace placement and capture.

## Compatibility

The AI SDK extraction model specification is experimental and can change in
patch releases. Gateway extraction models and AI SDK's empty-value
normalization arrive in `ai@7.0.176`, so eve's `ai` peer range starts there.
