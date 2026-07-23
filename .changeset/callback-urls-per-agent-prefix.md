---
"eve": patch
---

Fix connector-auth and remote-subagent callback URLs returning 404 in multi-agent mode. Generated per-agent Vercel services now bake the agent's public route prefix (`/eve/agents/<name>`) into their workflow function environment via `EVE_PUBLIC_ROUTE_PREFIX`, framework-minted callback URLs prepend it, and the session-callback validator accepts callback URLs mounted behind a route prefix so OAuth redirects and remote-subagent session callbacks reach the deployed agent.
