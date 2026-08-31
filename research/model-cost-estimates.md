---
issue: TBD
status: implemented
last_updated: "2026-08-31"
---

# Model cost estimates

## Summary

eve reports model cost for direct-provider and request-scoped BYOK calls when
AI Gateway cannot supply an authoritative cost. The estimate uses the model's
base public per-token prices and the usage reported by the AI SDK. Gateway
metadata always wins when it is present.

## Observable behavior

```text
AI SDK usage + Gateway metadata
  ├─ Gateway cost present -> costUsd, source: gateway
  └─ Gateway cost absent + known base price -> costUsd, source: estimated
```

`step.completed.data.usage` includes both `costUsd` and `costSource`. Turn
workflow attributes retain the compatibility total in `$eve.cost_usd` and add
`$eve.gateway_cost_usd` and `$eve.estimated_cost_usd` for source-aware
rollups. OTel spans use `gen_ai.usage.cost` with `eve.cost.source` set to
`gateway` or `estimated`.

## Pricing and limits

Model identity and context limits remain sourced from AI Gateway's catalog.
Base pricing comes from its public `/v1/models` response and is cached with
the compile-time catalog metadata. Unavailable, malformed, or incomplete
pricing never prevents a model from compiling or running; eve emits no
estimate for that call.

## Accuracy boundary

Estimated cost is observability metadata, not billing. It does not model
long-context tiers, regional rates, service tiers, multimodal pricing,
provider discounts, custom deployments, or gateway fallback routing. AI
Gateway-reported cost remains the authoritative value whenever available.
