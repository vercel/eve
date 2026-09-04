---
issue: https://github.com/vercel/eve/issues/2055
status: in-progress
last_updated: "2026-09-03"
---

# Nitro-first build and runtime integration

## Decision

eve will keep Nitro as its core host dependency and make the existing integration more direct,
predictable, and testable. Nitro remains responsible for the final host build, native dependency
classification and nf3 tracing, deployment presets, schedules, server lifecycle, and supported
runtime behavior. eve will not replace those systems with an eve-owned H3, CrossWS, srvx, nf3, or
platform-adapter stack.

The current pass also keeps using the Rolldown installation resolved by Nitro. An eve-owned lazy
wrapper isolates that reach-through and enforces correct resolution behavior, but importing a
transitive dependency remains technical debt. eve will move to a public Rolldown boundary only
after Nitro publishes a physical core or build package that declares Rolldown as a compatible peer.

The dependency-graph problem remains real, but it cannot be fixed inside eve while eve installs the
current `nitro` package. The upstream requirement is a physically separate Nitro core package with
its own package manifest. A `nitro/core` export, feature flags, or lazy imports would still make a
package manager resolve the umbrella manifest.

This plan carries forward the portable findings from the
[direct build and routing system review](https://github.com/vercel/eve/blob/barba/remove-nitro-build-runtime/research/nitro-removal-review.md)
without carrying forward the decision to remove Nitro.

## Ownership boundary

eve owns the agent compiler, authored-module loading, workflow artifact generation, and the
translation from compiled agent intent into Nitro configuration. Nitro owns the host graph and the
runtime behavior around that graph.

| Area                           | Owner | Boundary                                                                                                                                                |
| ------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent and workflow compilation | eve   | eve produces entries, transforms, route intent, and compiled artifacts for Nitro to consume.                                                            |
| Final application build        | Nitro | Nitro creates the base build graph, installs its plugins, invokes the bundler, traces externals, and writes output.                                     |
| Native dependency handling     | Nitro | Nitro classifies non-bundleable packages and runs nf3 tracing; eve supplies only authored or eve-specific additions through public configuration.       |
| Node and deployment output     | Nitro | Nitro presets own Node and Vercel output, environment aliases, runtime error behavior, and Bun selection where the selected preset supports it.         |
| HTTP and WebSocket runtime     | Nitro | Nitro owns H3, CrossWS, srvx, request upgrades, and preset-specific transport behavior.                                                                 |
| Schedules                      | Nitro | Nitro's task and schedule layer owns registration, execution, concurrency, and process integration.                                                     |
| eve development orchestration  | eve   | eve owns authored-source watching, immutable generations, worker replacement, and the outer draining server while delegating each worker host to Nitro. |

This boundary allows eve to improve the inputs and extension points around Nitro. It does not make
eve a second host framework.

## Current-pass improvements with umbrella Nitro

### September 2026 release

Upgrade to `nitro@3.0.260903-beta`, using the
[published release](https://github.com/nitrojs/nitro/releases/tag/v3.0.260903-beta)
and [tagged manifest](https://github.com/nitrojs/nitro/blob/v3.0.260903-beta/package.json)
as the compatibility boundary. The package contains newer primitives than parts
of the release summary: h3 `2.0.1-rc.31`, srvx `1.0.3`, env-runner `0.2.1`, and
Rolldown `1.2.7`.

`nitro` and the existing `undici` remain eve's only runtime dependencies.
The lockfile refresh also supplies CrossWS `0.4.12`, rou3 `0.9.2`, nf3 `0.3.24`,
ocache `0.3.0`, db0 `0.4.1`, and unstorage `2.0.0-alpha.10`. Nitro bundles its own
unctx and unwasm. Older versions needed by historical fixtures and Nuxt's
separate `nitropack` 2.x graph remain independent. No global overrides force
these consumers onto Nitro 3's versions.

eve vendors env-runner `0.2.1` as a development dependency, updates Vite to
`^8.2.2`, and keeps Vitest on the `4.1.11` patch line. Exact version exceptions
allow the required fresh releases and Rolldown native bindings through pnpm's
two-day release-age policy. The resolved Rolldown version and env-runner manifest
invalidate the existing vendor fingerprint; generated artifacts and license
notices are rebuilt together.

Both host constructors explicitly select `builder: "rolldown"`. A surrounding
application's Vite configuration must not select a different build pipeline or
trigger Nitro's automatic dependency installer. eve retains the public
`prepare`, `build`, asset-copying, and prerender APIs, workflow transforms,
conditional exports, native tracing, and Windows import normalization. Removed
Nitro auto-imports, typed fetch, and declaration generation are not eve inputs.

Channel parameters now use `getRouterParams(event, { decode: true })` from
`nitro/h3`. Ordinary text decodes once, encoded separators stay encoded, and
malformed encoding is rejected before dispatch. This is a public breaking
change. Static routes retain precedence, explicit HEAD handlers win over GET
fallback, and fallback keeps the captured GET channel identity while forwarding
the original HEAD request. eve retains compiler-owned CORS validation and
generated preflights, with h3 handling response headers.

The packed-host test found that Nitro's generated `H3Core` matcher omits h3's
HEAD fallback. An eve build plugin adds the missing second lookup to Nitro's
matcher only when the HEAD lookup returns no route. Explicit HEAD routes retain
precedence even across different static/dynamic patterns, and an explicit HEAD
handler returning 404 does not fall back. The plugin fails the build if Nitro's
generated matcher shape changes, requiring review at the next upgrade.

The existing eve-owned WebSocket types expose `bufferedAmount`, `waitForDrain`,
`ping`, `drain`/`ping`/`pong` hooks, and upgrade `protocol` selection. Operations
delegate to CrossWS peers; there is no new transport implementation. Control
frames and drain notifications depend on the host. CrossWS owns default liveness
checks; an adapter-level idle timeout is not a public eve route option.
Compatibility tests cover request-attached hook resolution once per connection,
handshake headers, rejected upgrades, protocol selection, and bounded drain waits.

The env-runner shutdown patch remains necessary: `0.2.1` still runs the IPC
close hook before closing its server and leaves the parent port open. eve keeps
its corrected ordering, immutable generations, readiness gates, crash recovery,
stream draining, and bounded worker termination. Production sandbox cleanup now
shares one promise across signals and Nitro close hooks. Signal supervision
remains necessary because srvx disables automatic signal handling in CI/test,
and schedule timers can otherwise retain the process. Development and Vercel
remain excluded from production sandbox cleanup.

Native Nitro tracing and its logger remain disabled by default: enabling them
would introduce a separate exporter outside eve's instrumentation policies.
The release's cache behavior is recorded for future use: SWR is disabled by
default; query parameters are stripped unless allowed; request cookies require
an allowlist and response `set-cookie` is removed; keys include URL authority;
and shared resolutions time out after 30 seconds by default
([Nitro cache documentation](https://nitro.build/docs/cache)). eve does not use
Nitro caching or db0 for workflow persistence, so this upgrade requires no state
migration. Immutable assets add no value while `publicAssets` is empty. Nitro's
text/bytes import plugins do not extend eve's earlier authored compilation.
Cloudflare development and distributed WebSocket pub/sub remain separate work.

Validation uses packed npm and pnpm consumers, including a conflicting Vite
configuration and checks that builds do not mutate manifests, lockfiles, or
installed package directories. Real production and development hosts exercise
HTTP and WebSocket behavior. Existing scenario coverage retains workflow,
conditional exports, native externals, extensions, Windows paths, and Vercel
output contracts. Deterministic HTTP fixture evals run only in CI. The historical
measurements below remain the record of the earlier core-package investigation.

The upgrade's local report compares commit `90917771` with the updated package
on macOS arm64 and Node 24.20.0, using the same isolated npm consumer reporting
tool. Fresh consumers resolve the manifest's dependency ranges; these counts
are not the monorepo lockfile's full graph.

| Metric                                       |   Before |    After |
| -------------------------------------------- | -------: | -------: |
| Packed install                               | 75.71 MB | 75.65 MB |
| Installed package instances                  |       35 |       33 |
| Optional peer edges                          |       47 |        7 |
| `eve init` packages                          |      122 |      120 |
| Packed tarball delta                         |        — |  -6.7 kB |
| Two Vercel function payloads, combined delta |        — |  -2.9 kB |

Existing size budgets pass unchanged. One recorded build took 1.15 seconds
before and 2.23 seconds after; the latter ran alongside regression tests, so
this is an informational profile, not evidence of a build-speed change.

### Contain the transitive Rolldown boundary

eve invokes Rolldown directly for its published JavaScript, compiled vendor artifacts,
authored-module evaluation, workflow bundles, and parser-backed transforms. In this pass, the
eve-owned lazy wrapper continues to resolve `rolldown` and `rolldown/parseAst` from Nitro's installed
dependency tree. This avoids adding another runtime declaration before Nitro defines a public
embedding boundary, but it remains an undeclared transitive contract: a fresh consumer install can
select a different Rolldown version from the one in eve's workspace lock.

All eve code that calls Rolldown should use the runtime wrapper, and package build scripts should
use the corresponding script wrapper. Both wrappers should stay lazy and enforce the same
resolution rules so importing parser-backed helpers does not initialize the native bundler. The
compiled-vendor stamp should include the resolved Rolldown version so a lockfile update invalidates
generated artifacts. nf3 remains owned and invoked by Nitro, so eve should not declare or call nf3
directly.

Rolldown resolution should preserve its per-import standard conditions. eve may add custom
conditions such as `eve-source` and `workflow`, but must not put `node`, `import`, `require`,
`browser`, or `default` in `resolve.conditionNames`. A shared assertion should reject those standard
condition names. Conditional-export fixtures should prove that ESM import and CommonJS require
edges retain their distinct package branches.

### Simplify eve's inputs to the Nitro build

The workflow builder can generate its final entry source directly instead of emitting an
intermediate file and repairing imports, code literals, source maps, and mirrored paths afterward.
This cleanup keeps the Nitro-specific transform exclusions, side-effect rules, aliases, and
`noExternals` policy that the final host build still requires.

eve should also centralize route computation in a typed registry, then translate that registry into
Nitro handlers and preset configuration. Nitro continues to mount and emit the routes. The registry
exists to keep HTTP, WebSocket, cron, package, development, and workflow route precedence consistent
across eve's configuration steps; it is not an eve-owned runtime router.

Public assets and prerender phases may be skipped only when Nitro exposes a supported builder
sequence and eve has neither public assets nor prerender routes. eve must not reproduce private
Nitro builder phases to remove those calls.

### Strengthen correctness at existing seams

The following changes do not require a new host:

- Preserve authored warnings while filtering warnings that come only from eve's compiled vendor
  artifacts. A warning involving both authored and vendor modules must remain visible.
- Reject WebSocket upgrades unless a WebSocket handler matched, and cover an HTTP handler and a
  WebSocket handler sharing one path. Fix this through Nitro configuration or upstream Nitro rather
  than a parallel router. Nitro's current upgrade resolver falls back to empty CrossWS hooks when
  the selected HTTP response has no WebSocket hooks, and its handler model cannot distinguish a GET
  route from a WebSocket route at the same path. Nitro therefore needs protocol-typed route entries
  or a public resolver that can return either WebSocket hooks or a rejected upgrade response.
- Retain explicit development-worker shutdown and fallback termination, and test request and
  `waitUntil` draining at the eve-owned outer server boundary.
- Do not claim end-to-end shutdown draining from the worker handshake alone. The current CLI parent
  gives its server child a shorter grace period than the worker fallback, and full outer-server
  shutdown releases workers before admitted requests and transitive `waitUntil` work are proven
  drained. Reconcile those budgets and add full-shutdown coverage before making a drain guarantee.
- Keep schedule lifecycle tests around admission, overlap, and shutdown while using Nitro's task
  runtime.
- Remove nested package builds that can race the package's destructive `dist` clean.
- Test route grammar against both Nitro's runtime matching and each selected deployment preset
  before broadening the public grammar.

## Deliberate non-goals

The removal branch proved several designs, but they do not fit the chosen ownership boundary:

- Do not vendor H3, CrossWS, srvx, or a schedule runtime into private eve artifacts.
- Do not create an eve-owned final Rolldown host graph, Fetch router, Node server, nf3 tracer, or
  Vercel Build Output emitter.
- Do not replace Nitro presets with eve-maintained platform adapters.
- Do not trade Nitro's native classification for an author-maintained list of external packages.
- Do not add a direct Rolldown runtime dependency while the umbrella Nitro package supplies the
  implementation. This staging choice contains the current private reach-through; it does not make
  that reach-through a supported long-term API.
- Do not remove Nitro-supported environment aliases, development error responses, signal behavior,
  source maps, Bun output, or route syntax without an explicit public breaking-change decision.
- Do not add direct H3, CrossWS, srvx, or nf3 dependencies merely to select newer versions. Nitro
  must test and supply compatible primitive versions for the host it owns.

These choices preserve the behavior and platform maintenance that justified keeping Nitro.

## Measured limitation of the umbrella package

The reviewed alternating warm-cache npm benchmark compared `eve@0.35.0` using
`nitro@3.0.260610-beta` with the removal branch's packed artifact. It establishes the package-graph
cost of the umbrella package, not a runtime-performance result.

| Metric                                  | Nitro boundary | Removal branch | Change |
| --------------------------------------- | -------------: | -------------: | -----: |
| External npm-managed package instances  |             34 |             17 |   -50% |
| Distinct external package names         |             33 |             16 |   -52% |
| Installed dependency bytes              |     42,104,410 |     36,597,645 | -13.1% |
| Dependency edges in installed manifests |             38 |             17 |   -55% |
| Optional peer edges                     |             47 |              4 |   -91% |
| npm lock-only median                    |        2.427 s |        1.052 s | -56.7% |
| Warm npm install median                 |        3.205 s |        1.837 s | -42.7% |

The branch's separate CI comparison against its merge base showed the same installation direction:
the packed install fell from 73.48 MB to 68.31 MB, installed files fell from 6,924 to 5,782, and an
`eve init` install fell from 121 packages to 85. That trade was not uniformly smaller: the packed
tarball grew by 70.5 kB and two sampled Vercel functions each grew by about 161.7 kB.

The benchmark used four alternating samples per artifact on Node 24.16.0, npm 11.13.0, macOS
arm64, and a shared warm cache. It shows a directional resolver and install result. It does not show
that the removal branch built applications faster, used less build memory, started faster, served
requests faster, or used less steady-state memory. No controlled comparison established those
claims, and both designs used Rolldown, H3, CrossWS, and srvx. A single shared-runner build profile
improved from 2.10 seconds to 1.54 seconds, but it was explicitly informational and too noisy to
support a build-performance claim.

The August Nitro manifest had 14 hard dependencies and eight optional peers. Its closure included
23 optional storage-provider peers from unstorage and six database-provider peers from db0. eve
cannot remove those manifest edges with imports, aliases, overrides, dynamic loading, or feature
flags. Moving dependencies to optional peers would reduce default installed bytes but would still
leave package managers to evaluate their metadata.

## Required Nitro package architecture

The install target requires a separately published Nitro core package, not a new export in the
existing package. The final upstream name may differ, but the package must have its own minimal
manifest and stable public exports.

The selected Nitro packages for eve must:

- Keep Nitro's builder, runtime application, route contracts, nf3 integration, task system, and the
  Node and Vercel preset behavior that eve uses.
- Avoid installing storage, database, cache, proxy, generic framework-development, Vite, or Rollup
  packages unless eve selects the corresponding component.
- Expose a public build boundary for the Rolldown operations embedders invoke, with supported
  exports and types rather than access through Nitro's private dependency tree.
- Declare Rolldown as a compatible peer of the build component so eve can pin and install one exact
  version after migrating from the umbrella package, without a second native binding.
- Keep storage and database integrations in opt-in physical packages so unstorage and db0 peer
  metadata never enters eve's default consumer graph.
- Allow the umbrella `nitro` package and CLI to depend on the core and optional components, keeping
  Nitro's turnkey experience without imposing the full graph on embedders.

Stable APIs are also needed at the seams eve currently reaches through hooks and option mutation:

- A typed route manifest or injected-application boundary that represents HTTP and WebSocket
  handlers independently while leaving mounting to Nitro.
- Supported build hooks for entry generation, plugin order, aliases, externals, warnings, and
  post-build output changes without patching a plugin by name.
- Observable classification and trace results while Nitro remains responsible for running nf3 and
  writing the traced dependency tree.
- Preset extension points for routes, functions, crons, headers, and service layouts without
  rewriting Nitro's emitted Vercel output.
- A Node adapter with `waitUntil` retention and the Node-adapter fixes introduced in srvx 0.12.
  The September umbrella release now supplies srvx 1.0.3, satisfying this part of the requirement.
- A disposable Node preset contract with bounded asynchronous shutdown across requests,
  WebSockets, schedules, lifecycle hooks, signals, and transitive `waitUntil` work.
- A published compatibility matrix for Nitro's supported Rolldown, H3, CrossWS, srvx, and nf3
  versions.

The physical package split is the gate for dependency-resolution gains. The APIs improve
integration quality, but adding them to the umbrella package alone does not shrink its manifest.

## Acceptance and validation

### Current pass

The cleanup against the umbrella Nitro package is ready when:

1. `nitro` remains an exact runtime dependency and all production host builds still enter through
   public Nitro exports.
2. `rolldown` is not an eve runtime dependency. Parser-backed and build-backed code resolves
   Nitro's installed Rolldown through the eve-owned lazy wrapper and works from a packed npm install
   outside the monorepo.
3. The vendor stamp records the resolved Rolldown version, and every direct Rolldown call in eve
   source and build scripts goes through an eve-owned wrapper with the same resolution checks.
4. Conditional-export fixtures cover ESM import edges, CommonJS require edges, custom eve
   conditions, and packages that expose different values for those paths.
5. Workflow output no longer depends on repair-only rewrites or duplicate mirrors, and existing
   workflow identity, replay, source discovery, and Vercel execution scenarios pass.
6. One typed route registry drives Nitro handler and preset configuration, with tests for
   precedence, deduplication, CORS, shared HTTP/WebSocket paths, strict upgrades, cron routes, and
   co-deployed service prefixes.
7. Nitro still owns nf3 tracing. Native packages, nested pnpm packages, author-configured
   externals, and multiple installed versions remain covered by scenario tests.
8. Node and development shutdown tests cover admitted requests, transitive `waitUntil` work,
   WebSockets, schedules, worker replacement, signals, and close hooks without replacing Nitro's
   host implementation.
9. Vercel scenarios preserve Nitro-generated functions, routes, crons, environment aliases, error
   behavior, and Bun selection where supported.
10. Bundle analysis reports the packed tarball, installed bytes and files, installed package
    instances, dependency edges, and optional peer edges. Any claimed improvement uses the same
    package manager, cache state, platform, and sampling method as its baseline.
11. Unit, integration, scenario, TUI packed-install, and CI-only fixture evals pass at the narrowest
    tier that exercises each changed boundary.

### Upstream package follow-up

Migrating to a future Nitro core or build package requires a separate change and a new
packed-install benchmark. That migration is ready when the selected Nitro package set does not
install unstorage, db0, or their provider peer metadata; the build package exposes a public
Rolldown boundary and declares a compatible Rolldown peer; eve pins that peer to one exact runtime
version; and the packed install contains one Rolldown instance. The migration must retain every
Nitro-owned behavior listed above.

Runtime-performance claims remain separate from both stages. They require controlled build,
cold-start, throughput, and memory benchmarks.
