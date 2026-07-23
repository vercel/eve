---
"eve": patch
---

Fix connector-auth and remote-subagent callback URLs returning 404 in multi-agent mode. Generated per-agent Vercel services now bake the agent's public route prefix (`/eve/agents/<name>`) into their workflow function environment via `EVE_PUBLIC_ROUTE_PREFIX`, and framework-minted callback URLs prepend it so OAuth redirects and remote-subagent session callbacks reach the deployed agent.
