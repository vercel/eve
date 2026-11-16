---
issue: "https://github.com/vercel/eve/issues/4948"
status: implemented
last_updated: "2026-11-16"
---

# Nuxt managed production startup

## Authoring and deployment contract

Keep the existing `eve/nuxt` options. For non-Vercel server builds, start an
already-built eve service per agent when no production origin is configured.
Use the shared framework discovery for standalone `agent/` projects and
`agents/` workspaces. Standalone builds need a separate output from Nuxt;
workspace members need to be built from their own directories, not with a root
`eve build`, which produces a Vercel workspace deployment. Building eve remains
the deployment's responsibility.

Resolve `EVE_NUXT_PRODUCTION_ORIGIN` and `EVE_NUXT_PRODUCTION_PORT` at build time.
An explicit origin disables managed startup. Otherwise, the generated Nitro
plugin and proxy share fixed loopback destinations. Workspace members use
consecutive ports in discovery order, with public `/eve/<name>/v1` routes proxied
to each backend's `/eve/v1`. Runtime routing variables cannot change only one
side of that relationship.

Record `eveRoot` relative to the Nuxt project root so deployments can move.
At startup, resolve that path against the working directory. The runtime-only
`EVE_NUXT_PRODUCTION_ROOT` override accepts absolute paths or paths relative to
that working directory. Record each member's root relative to the eve project
root so the override relocates the entire workspace. Reject shared Nuxt/eve output and the running Nuxt entry
before spawning a child. Neither prerendering nor static generation starts eve.

Managed startup supports a single Node.js process using Nitro's `node-server`
preset. Reject other configured/environment presets at build time and reject
cluster workers or worker threads at runtime. Clustered or multi-process
frontends must set an externally managed `EVE_NUXT_PRODUCTION_ORIGIN` at build
time; this change does not coordinate backend ownership across workers.

## Runtime boundary

The generated Nitro plugin only imports and configures the plugin factory from
`eve/nuxt/production-server`, with Nitro's prerender guard. All startup,
readiness, and failure handling lives in that eve-owned runtime entry, not in
generated code. This entry exists for production code, not as an authoring API
or test seam. Its configuration carries each fixed `origin`, public route
prefix, portable project `relativeRoot`, and project-relative `agentRoot`.
Startup is deduplicated per origin in the process through the shared process
manager.

Keep the import literal. Ship this runtime entry as a self-contained bundle
with only Node.js builtin imports, and inline it into Nitro's output. Nitro's
tracer skips workspace symlinks, and its alias resolver cannot preserve eve's
private imports. Installed and workspace-linked packages use the same boundary;
no new runtime dependency or hidden import is needed.

The synchronous plugin registers an awaited request hook for each public prefix.
Each agent's requests wait only for that agent's bounded startup promise,
resolved only when the child reports srvx's successful bind at the configured
origin. A TCP listener alone cannot prove that the child owns the port. The shared
helper also serves Next.js, whose custom-channel deployments may omit health.
Clear inherited `TEST`, `CI`, `SERVER_SHUTDOWN_TIMEOUT`, and `NITRO_UNIX_SOCKET`
so srvx reports the bind, runs bounded shutdown, and uses the configured port.
An existing listener, child exit, and bind failures remain startup errors.
Failed startup returns a generic `503` on these routes, while diagnostics
remain in server logs. The frontend may serve unrelated requests independently.

Own the child immediately after spawn. Listen for Nitro's configured shutdown
signals to abort pending startup before Nitro drains HTTP requests; otherwise,
a request awaiting readiness can delay cleanup past the termination bound.
Require Nitro graceful shutdown to remain enabled. The close hook removes the
signal listeners, aborts pending startups
and closes all running children, awaiting termination concurrently. Send SIGTERM, allow 20
seconds for graceful shutdown, then escalate to SIGKILL with a one-second reap
bound. Clear startup timers and process listeners on completion.

## Validation boundary

Use a real Nuxt build with prerendering, relocate both independently built
outputs outside the fixture's dependency tree, and request eve's health route
through Nuxt. Exercise build-only routing variables, the relative root override,
static generation, and an externally managed origin. Delay the real backend's
startup to check the first transport request without health polling. Verify
failed, missing, and occupied backend startup returns `503`, and retain the
workspace Nuxt fixture build alongside the relocated installed-package scenario.
Use fake timers for the three-minute startup and bounded shutdown deadlines,
with a mock child for normalized port 80 and SIGTERM escalation. A narrow real
socket/child scenario owns route-independent readiness, pending-startup
cancellation, and a competing listener claiming the port after preflight. Next.js
must reject config loading rather than install rewrites to that listener. Verify configured and environment cluster presets fail at build,
external origins work with cluster, and runtime workers cannot spawn eve.
A real Nuxt workspace build checks consecutive ports, public-to-backend path
translation, whole-workspace root relocation, and termination of both children.
Unit coverage checks that a pending or failed agent does not gate another agent
or unrelated paths.
