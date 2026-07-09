---
"eve": patch
---

Add the `islo()` sandbox backend, available from `eve/sandbox/islo`. It targets the [Islo.dev](https://docs.islo.dev) hosted sandbox provider through its Vercel-compatible API: Vercel sandbox API calls are rewritten to Islo's base URL (`https://api.islo.dev` by default, overridable via `apiBaseUrl`), and the API token falls back to `ISLO_TOKEN` then `ISLO_API_KEY` when not passed explicitly.
