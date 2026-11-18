---
"eve": minor
---

Add `eve/solid` with `useEveAgent` for Solid 2 apps.

The binding has the same options and methods as the React, Vue, and Svelte bindings, and exposes state as Solid accessors such as `agent.messages()` and `agent.status()`. Register `eveVite()` to mount the agent routes, and add `nitro()` from `nitro/vite` to deploy a server-rendered Solid app to Vercel. `solid-js` 2 is an optional peer dependency.
