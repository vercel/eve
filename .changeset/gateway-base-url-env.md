---
"eve": patch
---

`validateGatewayApiKey` now honors the `AI_GATEWAY_BASE_URL` environment variable when constructing the gateway provider, so the `AI_GATEWAY_API_KEY` check can be pointed at a self-hosted or proxied AI Gateway instead of always hitting `ai-gateway.vercel.sh`.
