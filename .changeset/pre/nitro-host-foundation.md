---
"eve": patch
---

A `HEAD` request to a channel path that declares `GET` but not `HEAD` now gets `405 Method Not Allowed` with an `Allow` header instead of `404`, and the `GET` handler doesn't run.

Declare `HEAD()` on a path to answer `HEAD` requests there, under any parameter name: `HEAD("/items/:itemId")` answers for `GET("/items/:id")`. Paths that already declare `HEAD()`, such as `/` and `/eve/v1/health`, are unchanged. On a CORS-enabled path, the `405` carries the CORS headers, so a browser can read it.

`eve build` and `eve dev` no longer merge the app root's `nitro.config`, `.nitrorc`, or `.env` files into eve's own Nitro host, and no longer serve an app-root `server.*` or `index.html` as a catch-all in front of eve's routes. A Nitro app that shares its root with an eve agent, such as a TanStack Start host, keeps its Nitro configuration to itself. eve still loads `.env`, `.env.local`, `.env.development`, and `.env.development.local` for `eve dev` through its own environment handling, and still serves files in an app-root `public/` directory as static files.

`eve dev` now rebuilds its host when a connection turns on events or an extension mount changes the package export it imports. Before, those edits reused the running host, so the event receiver route or the new mount stayed missing until `eve dev` restarted.
