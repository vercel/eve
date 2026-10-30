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

The generated Nitro plugin imports `ensureEveProductionServer` from
`eve/nuxt/production-server`. This entry exists for production code, not as an
authoring API or test seam. Its configuration carries the fixed `origin` and
portable `relativeRoot`; startup is deduplicated per process through the existing
shared process manager.

Keep the import literal and externalize eve through Nitro so its tracer copies
the package imports into the server output. Do not hide a dynamic import from
the bundler or pass a bare package name as a trace filename. No new runtime
dependency is needed.

## Validation boundary

Use a real Nuxt build with prerendering, relocate both independently built
outputs outside the fixture's dependency tree, and request eve's health route
through Nuxt. Exercise build-only routing variables, the relative root override,
static generation, and an externally managed origin.
