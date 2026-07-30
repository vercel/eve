---
"eve": patch
---

Records Vercel AI Gateway cost on local trace spans: `agent.step` spans now carry `gen_ai.usage.cost`, `gen_ai.usage.gateway_cost`, `gen_ai.usage.input_cost`/`output_cost`, and `gen_ai.generation.id` when the gateway reports them. The attributes only exist for gateway-served calls — other providers emit nothing.
