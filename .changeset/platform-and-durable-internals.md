---
"eve": patch
---

eve now isolates its platform assumptions behind an internal `definePlatform()` declaration, boots its application as an explicit `App` with lifetimes and ordered phases, and runs sessions behind a generic `Durable` engine interface with one step dispatcher and a Node-free session program; runtime behavior on Vercel is unchanged.

Three internal safety changes are included: the outbound request guard fails closed when `fetch` ignores its dispatcher, each Workflow run stamps a hash of its session code so branch builds do not replay across different code, and `localDev()`, `placeholderAuth()`, and OIDC route auth see no platform facts when called in a plain process with no eve app or platform module.

Thanks @OwenKephart for the session record and Node-free session core in #6455 and #6074.
