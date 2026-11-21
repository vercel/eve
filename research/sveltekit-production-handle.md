---
issue: https://github.com/vercel/eve/issues/4211
status: implemented
last_updated: 2026-11-16
---

# SvelteKit production proxy

Non-Vercel SvelteKit production adapters need a same-origin route to an
operator-managed eve backend. The shared Vite plugin owns development,
preview, and Vercel service generation; production proxying belongs in a
SvelteKit server hook, not another Vite integration.

## Authoring API

```ts
import { createEveHandle } from "eve/sveltekit";

export const handle = createEveHandle();
```

The default forwards `/eve/v1/**` to loopback port `4274`, overridden by
`EVE_SVELTEKIT_PRODUCTION_PORT`. `origin` overrides
`EVE_SVELTEKIT_PRODUCTION_ORIGIN`; both select one upstream host and keep
public paths, including `/eve/<name>/v1/**`.

For a workspace whose members run on separate servers:

```ts
export const handle = createEveHandle({
  agents: {
    alice: "http://127.0.0.1:4274",
    bob: "http://127.0.0.1:4275",
  },
});
```

`agents` takes precedence over the shared origin. Only listed names are
mounted, and `/eve/<name>/v1/**` becomes `/eve/v1/**` upstream. Explicit
mapping avoids runtime filesystem discovery and implicit port ordering.
The production frontend needs neither agent files nor the Vite plugin's
resolved configuration. All other requests reach SvelteKit's resolver.

## Boundaries

- Operators build, start, secure, and supervise each backend. The hook does
  not start eve, configure workflow callbacks, or replace backend auth.
- Preserve query strings, methods, streamed bodies, aborts, response-body
  cancellation, status, redirects, and separate cookies.
- Remove hop-by-hop headers in both directions, the incoming `Host`, and
  decoded response representation headers that no longer describe the body.
- Vercel service routing remains unchanged and needs no hook. There is no
  environment-based bypass if a request reaches the hook.

Unit tests own route selection and configuration. Focused HTTP scenario tests
own streaming, cancellation, redirect, cookie, and header behavior across a
real Fetch transport. Full deployment and model suites remain CI-owned.
