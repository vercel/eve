---
"eve": patch
---

`eve build` and `eve dev` no longer merge the app root's `nitro.config`, `.nitrorc`, or `.env` files into eve's own Nitro host, and no longer serve an app-root `server.*` or `index.html` from it.

A Nitro app that shares its root with an eve agent, such as a TanStack Start host, keeps its Nitro configuration to itself. Before, Nitro picked up a root `server.ts` or `index.html` as a catch-all in front of eve's routes. eve still loads `.env`, `.env.local`, `.env.development`, and `.env.development.local` for `eve dev` through its own environment handling.
