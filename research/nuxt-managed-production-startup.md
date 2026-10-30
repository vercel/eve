---
issue: "https://github.com/vercel/eve/issues/4948"
status: implemented
last_updated: "2026-10-30"
---

# Nuxt managed production startup

## Authoring and deployment contract

Keep the existing `eve/nuxt` options. For non-Vercel server builds, start an
already-built eve service from a separate `eveRoot` when no production origin
is configured. Building eve remains the deployment's responsibility.

Resolve `EVE_NUXT_PRODUCTION_ORIGIN` and `EVE_NUXT_PRODUCTION_PORT` at build time.
An explicit origin disables managed startup. Otherwise, the generated Nitro
plugin and proxy share one fixed loopback destination. Runtime routing variables
cannot change only one side of that relationship.

Record `eveRoot` relative to the Nuxt project root so deployments can move.
At startup, resolve that path against the working directory. The runtime-only
`EVE_NUXT_PRODUCTION_ROOT` override accepts absolute paths or paths relative to
that working directory. Reject shared Nuxt/eve output and the running Nuxt entry
before spawning a child. Neither prerendering nor static generation starts eve.

## Runtime boundary

The generated Nitro plugin only imports and configures the plugin factory from
`eve/nuxt/production-server`, with Nitro's prerender guard. All startup,
readiness, and failure handling lives in that eve-owned runtime entry, not in
generated code. This entry exists for production code, not as an authoring API
or test seam. Its configuration carries the fixed `origin` and portable
`relativeRoot`; startup is deduplicated per process through the shared process
manager.

Keep the import literal. Ship this runtime entry as a self-contained bundle
with only Node.js builtin imports, and inline it into Nitro's output. Nitro's
tracer skips workspace symlinks, and its alias resolver cannot preserve eve's
private imports. Installed and workspace-linked packages use the same boundary;
no new runtime dependency or hidden import is needed.

The synchronous plugin registers an awaited request hook for `/eve/v1/**`.
Requests wait for a bounded startup promise, resolved by eve's health endpoint
rather than optional startup logs. Failed startup returns a generic `503` on
these routes, including the deployment readiness endpoint, while diagnostics
remain in server logs. The frontend may serve unrelated requests independently.

## Validation boundary

Use a real Nuxt build with prerendering, relocate both independently built
outputs outside the fixture's dependency tree, and request eve's health route
through Nuxt. Exercise build-only routing variables, the relative root override,
static generation, and an externally managed origin. Delay the real backend's
startup to check the first transport request without health polling. Verify
failed, missing, and occupied backend startup returns `503`, and retain the
workspace Nuxt fixture build alongside the relocated installed-package scenario.
Use fake timers for the three-minute bound and a mock child for normalized port 80.
