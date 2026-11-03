---
issue: "None (maintainer-requested migration plan)"
status: in-progress
last_updated: "2026-10-30"
---

# Nitro 3 RC migration and host foundation

## Decision

Move eve from `nitro@3.0.260903-beta` to `nitro@3.0.261029-rc`. Replace the undeclared, transitive
`rolldown@1.2.9` with an exact, eve-declared `rolldown@1.2.16`.

Use the migration to rebuild eve's host layer into a materially simpler, data-driven foundation:

- Nitro is configured once, from a typed host spec.
- One ordered set of filtered build plugins serves the whole host build.
- One route table produces every handler.
- One externals policy decides what is bundled, traced, or left external.
- A small dev supervisor runs on env-runner's public `RunnerManager`.
- Tests assert behavior, not hook names or virtual ids.

Integrate only through the RC's public surfaces:

- `deps.paths`
- `buildPlugins`
- `build:config`
- `entry`
- `handlers`
- `virtual`
- `tasks`
- `scanDirs`
- `typescript`
- `traceDeps`
- `noExternals`
- `vercel.*`
- the `nitro/builder` sequence
- for development, env-runner 0.3's `RunnerManager` and `NodeWorkerEnvRunner`

Delete the reach-through, plugin patching, generated-module rewrites, and dead machinery those
surfaces replace.

This supersedes the Rolldown staging decision in
[`nitro-core-integration.md`](./nitro-core-integration.md). The RC dropped Rolldown, declares it as
a compatible package (`compatiblePackages.rolldown: ">=1.0.0"`), and lets a framework hand Nitro
its own copy through `deps.paths`. That is the public boundary the earlier plan asked for.

The ownership boundary in that document still holds:

- **Nitro owns** the host build, presets, H3, CrossWS, srvx, nf3, and tasks.
- **eve owns** the compiler, authored-module loading, workflow artifacts, and the translation of
  compiled intent into Nitro configuration.

Maintainers approved making `rolldown` eve's second runtime dependency. eve implements this plan
from scratch and supersedes the outside pull request
[#5167](https://github.com/vercel/eve/pull/5167). See [Provenance](#provenance).

## Target versions

| Package      | Today (lockfile)                      | Target                   | Who declares it                    |
| ------------ | ------------------------------------- | ------------------------ | ---------------------------------- |
| `nitro`      | 3.0.260903-beta                       | 3.0.261029-rc            | eve, exact                         |
| `rolldown`   | 1.2.9, via pnpm hoist only            | 1.2.16                   | eve, exact (new)                   |
| `h3`         | 2.0.1-rc.32                           | 2.0.8 (stable)           | Nitro                              |
| `rou3`       | 0.9.2                                 | 1.0.x                    | Nitro                              |
| `crossws`    | 0.4.12                                | 0.4.17                   | Nitro                              |
| `srvx`       | 1.0.5                                 | 1.0.8                    | Nitro                              |
| `env-runner` | 0.2.3 (Nitro), 0.1.16 (eve, vendored) | 0.3.x for both           | Nitro; eve vendors a matching copy |
| `nf3`        | 0.3.24                                | bundled inside Nitro     | Nitro                              |
| `unstorage`  | 2.0.0-alpha.10 (Nitro dependency)     | removed from eve's graph | nobody                             |

eve adds no direct dependencies on H3, CrossWS, srvx, or nf3.

Rolldown 1.2.16 rather than 1.2.15, for two reasons:

- It fixes rolldown#11341, the runtime-helper placement bug behind eve #5514 and #5519.
- Vite 8.3.5 depends on `rolldown ~1.2.14`, so apps that also use Vite can dedupe to a single
  native binding.

Every new release falls inside `minimumReleaseAge: 2880`:

| Release             | Eligible from              |
| ------------------- | -------------------------- |
| Nitro RC            | about 2026-10-31 12:00 UTC |
| Rolldown 1.2.16     | about 2026-10-31 14:31 UTC |
| `env-runner@0.3.11` | about 2026-11-01 01:31 UTC |

pnpm resolves `^0.3.10` to 0.3.10 until then. Wait for those times; add no release-age exclusions.

## What the RC changes for eve

Every finding below was verified against at least one of:

- the RC tarball;
- Rolldown 1.2.9 and 1.2.16 installed side by side;
- an RC build of `apps/fixtures/weather-agent` in a scratch worktree;
- scratch RC builds.

Current eve typechecks against the RC with 0 errors, so every break is in runtime or packaging
behavior. Inside the monorepo, pnpm's hidden `.pnpm/node_modules` hoist masks the dependency
breaks. Only a packed npm install outside the workspace shows them.

### Breaks

| Change                                                          | Effect on eve                                                                                                                                                                                              |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rolldown is an on-demand dependency                             | The `nitro-rolldown` wrappers resolve `rolldown` from Nitro's directory. In the worktree they find it only through the hoist (Nuxt's 1.2.9). A consumer npm install fails.                                 |
| Missing on-demand deps are auto-installed                       | If Nitro can't resolve a builder, `unstorage`, or `db0`, `ensureDep` edits the user's `package.json`: silently in CI, agent, and non-TTY runs, with a prompt in a TTY.                                     |
| `unstorage` is on-demand and runtime-scoped                     | `channel/skill-files.ts` imports `nitro/storage`, now `useKV`, which imports `unstorage`. Nitro installs `unstorage` whenever a Nitro runtime file imports it. The RC build bundles `_libs/unstorage.mjs`. |
| `rollup:before` deprecated for `build:config`                   | eve registers it 8 times, so every `eve build` and `eve dev` rebuild prints a deprecation warning.                                                                                                         |
| Dev entry exports `websocket.resolve`, built on srvx 1.0.8      | eve's vendored `env-runner@0.1.16` worker (srvx 0.11, crossws 0.4.12) would host it. eve's source patch can't apply to 0.3.x.                                                                              |
| Traced externals keep `nitro:traced/<n>/<id>` in chunk metadata | Nitro rewrites traced import ids only while rendering. eve's external-dependency output check reads `chunk.imports`, so it sees placeholders instead of package names.                                     |
| HEAD is served by GET routes; wrong methods get 405             | Authored GET routes, including the MCP stream, run for HEAD requests. Wrong-method requests return 405 with `Allow` instead of 404.                                                                        |
| Vercel `src` built with `routeToRegExp`                         | `src` becomes an escaped regex. `eve-service-route-output.ts` matches the literal text `/eve/v1` in `src`, so it now matches only through `dest`.                                                          |
| Vercel function runtime read from `package.json` engines        | The generated runtime follows the app's `engines`, not the build machine's Node.                                                                                                                           |
| `NITRO_UNIX_SOCKET`                                             | `eve start` forwards `process.env`. If the variable is set, the child listens on a socket and readiness detection times out.                                                                               |

### Rolldown 1.2.16 behavior

| Change                                                                      | Effect on eve                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full minify folds `["#compiled","run","index.js"].join("/")` into a literal | eve's published `dist` is built with full minify. Under 1.2.16 the `shared/workflow-sandbox.ts` fallback becomes ``import(`#compiled/run/index.js`)``, which pulls the `run` runtime into every hosted app. 1.2.9 does not fold, and neither does Nitro's `"dce-only"` host build. |
| `checks.pluginTimings` renamed to `bundlerTimings`                          | `bin-build-output.scenario.test.ts` waits for a stale marker (an existing bug).                                                                                                                                                                                                    |
| Unresolved-import diagnostics name the resolved specifier                   | Message assertions in `production-build-isolation` and `package-consumption` need rechecking.                                                                                                                                                                                      |

### Integration details

| Finding                                                                                                                 | Effect on eve                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replace` rewrites `import.meta.{dev,server,client,preset,baseURL,…}` in every JS module except `raw:`/`bytes:`/`text:` | Any data eve inlines into generated JS is exposed. The bootstrap inlines the full manifest (`compiled-artifacts.ts`), so instruction or skill text containing those tokens is silently rewritten in production. The beta does this too.                                                                                |
| `bytes:` modules export one shared `Uint8Array`                                                                         | Every reader shares it, and so does every file with the same digest.                                                                                                                                                                                                                                                   |
| Handler paths normalized to `/` (nitrojs/nitro#4908)                                                                    | eve's routing-module Windows rewrite is redundant.                                                                                                                                                                                                                                                                     |
| `scanDirs` scans `tasks/` whenever `experimental.tasks` is on                                                           | eve passes `scanDirs: [src/execution]`. With tasks enabled at `createNitro`, eve's internal `execution/tasks/*` modules become Nitro tasks; a scratch RC build registered `start`. The beta avoided this only because eve turned tasks on after the scan. Once tasks come from the config, `scanDirs: []` is required. |
| `_cli` is not read by the builder                                                                                       | eve's `_cli` options do nothing.                                                                                                                                                                                                                                                                                       |
| `#nitro/` virtual ids are Nitro-owned                                                                                   | eve registers `#nitro/virtual/eve-channel/*`.                                                                                                                                                                                                                                                                          |
| Presets finish choosing `entry` in `build:before`; Cloudflare wraps `options.entry`                                     | eve can put its instrumentation wrapper in front of the preset entry without rewriting the bundler `input`.                                                                                                                                                                                                            |
| `nitro:tsconfig-paths` plugin                                                                                           | It runs alongside eve's `rolldownConfig.tsconfig`. eve has three tsconfig policies of its own.                                                                                                                                                                                                                         |
| env-runner 0.3 graceful shutdown                                                                                        | In-flight work gets up to `timeout/2` before close hooks. The 0.1.16 patch force-closed it.                                                                                                                                                                                                                            |
| Chunk-group `debugName`                                                                                                 | eve's `MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME` filter is dead.                                                                                                                                                                                                                                                        |
| Tasks stop on close; async plugins gate requests on `app.ready`                                                         | The process can exit on its own after close, so eve's own signal handler and `process.exit` become unnecessary.                                                                                                                                                                                                        |

### Unaffected surfaces

- The `nitro/builder` order, which matches the RC CLI.
- `options.handlers` and `options.virtual`.
- Task and schedule registration.
- `vercel.cronHandlerRoute` and `functionRules`.
- `H3Event`, `defineWebSocketHandler`, and `handleCors`.
- Route normalization of eve's patterns.
- The global srvx `FastResponse`.
- Named catch-alls, which eve's grammar doesn't have.
- `eveTanStack()`, which only merges `vercel.config`.
- Emitted `new URL(…, import.meta.url)` assets, an improvement: `just-secrets`' `windows.ps1` now
  ships in hosted output.

### Not fixed by the RC

`resolveWebsocketHooks` still falls back to `{}`. An upgrade on a path whose matched handler has
no WebSocket hooks is still accepted with no-op hooks.

## Foundation invariants

These hold after the migration, and review and `guard:invariants` enforce them:

1. **Nitro is configured from data.** One adapter turns a typed host spec into the `NitroConfig`
   passed to `createNitro`. Nothing writes `nitro.options` afterward. The only hooks eve uses are
   declared in that config: the `build:before` entry wrapper and `build:config` edits that public
   options can't express. No `rollup:before`.
2. **Development and production differ by data, not code paths.** One spec function covers both.
3. **One ordered, filtered plugin list per build.**
   - Every eve build plugin uses hook `filter`s, except where it truly needs every id.
   - Authored-source builds share one plugin factory.
   - Nothing patches a third-party plugin or rewrites Nitro's generated modules.
4. **Generated code carries data through `text:` or `bytes:` imports,** never as inlined JS
   literals, so Nitro's `replace` can't touch it.
5. **Every eve-owned Nitro id uses `#eve/`.** No `#nitro/` ids, no ad hoc prefixes.
6. **eve never lets Nitro resolve or install a dependency.** Rolldown comes through `deps.paths`.
   Storage and database runtimes are rejected in authored code.
7. **Post-build output rewriting is a named, shrinking list.** Each entry is tied to an upstream
   ask, and new entries need justification.
8. **Development host builds are one-shot.** eve configures no watchers, watch options, or reload
   hooks on Nitro.
9. **Tests protect behavior.** No test pins private Nitro ids or hook names, or calls Nitro hooks
   by hand. Production code has no seams that exist only for tests.

## Target architecture

```text
compiled manifest + mode ──► host spec (pure, typed)
   │                             routes · plugins · externals · entry wrapper · preset options
   │                             runtime plugins · workflow artifacts · fingerprint input
   ▼
workflow builder ──► { stepsPath, workflowsPath, stepTargets }   (data; one directory)
   ▼
nitro adapter ──► createNitro(NitroConfig) ──► prepare → copyPublicAssets → prerender → build
   ▼
named output shims (Vercel crons, service fallback) ──► publish
```

| Module                              | Responsibility                                                                                                                                                          | Replaces                                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `nitro/host/host-spec.ts`           | `createHostSpec(preparedHost, mode, dirs)`: a pure function from the compiled manifest to the full host intent.                                                         | The decide-then-mutate flow in `create-application-nitro.ts` and the dev/prod near-copies.                                                 |
| `nitro/host/host-routes.ts`         | One route table rendered into `handlers`, `virtual`, `tasks`, `scheduledTasks`, and the cron route. Each entry carries its Vercel function intent and HEAD `Allow` set. | `configure-nitro-routes.ts`, `channel-routes.ts`, `schedule-task-routes.ts`, `cron-handler-route.ts`, and the consumer route special case. |
| `nitro/host/route-handlers.ts`      | Codegen for channel, host, and WebSocket handlers, including the HEAD guard.                                                                                            | Per-module virtual strings.                                                                                                                |
| `nitro/host/host-plugins.ts`        | The ordered host plugin list with filters: step transform, one side-effects plugin over an exact id set, instrumentation entry, and the hosted-graph plugin.            | Five `unshift` hooks, the routing rewrite, and `createNitroBundlerConfig`.                                                                 |
| `nitro/host/externals-policy.ts`    | Computes `traceDeps`, `noExternals`, substitutions, and output checks once from the manifest, preset, and mode.                                                         | The overlapping externals mechanisms described below.                                                                                      |
| `nitro/host/hosted-graph-plugin.ts` | The single plugin for module substitutions (sandbox prune, dev-runtime prune, unconfigured optional engines) and the output check.                                      | Two prune plugins, the optional-engine plugin, and the output-check plugin.                                                                |
| `nitro/host/create-host-nitro.ts`   | The only Nitro-aware adapter: `createNitro(toNitroConfig(spec), loadOptions)`.                                                                                          | Both `create*ApplicationNitro` functions.                                                                                                  |
| `nitro/host/vercel-output.ts`       | The named post-build shims only (service crons and fallback). It shrinks as upstream asks land.                                                                         | `normalize-vercel-service-crons.ts` and the normalize half of `vercel-workflow-output.ts`.                                                 |
| `workflow-bundle/builder.ts`        | Returns step targets as data, writes one workflow directory, and owns its external lists.                                                                               | Regex re-parsing of `steps.mjs`, duplicate `steps.mjs` and `workflows.mjs` copies, and the build queue.                                    |
| `bundler/rolldown.ts`               | eve's Rolldown loader with types from `"rolldown"`.                                                                                                                     | The `nitro-rolldown` wrappers and hand-written option shapes.                                                                              |
| `bundler/authored-plugins.ts`       | One authored-source plugin factory for the authored module graph, loader, extension builds, workflow builder, and host.                                                 | Five hand-ordered lists.                                                                                                                   |
| `nitro/runtime/`                    | One generated eve runtime plugin, plus a lifecycle plugin that uses only close hooks.                                                                                   | Several side-effect plugins that talk through `process.env` and globals, and the signal handler with `process.exit`.                       |
| `nitro/dev/host-supervisor.ts`      | Readiness-gated swaps, the spare worker, host refcounts, crash restart, and close, all on `RunnerManager`.                                                              | `DrainedNitroDevServer`.                                                                                                                   |
| `nitro/dev/dev-runner.ts`           | `EveDevRunner extends NodeWorkerEnvRunner`, with a 15-second `shutdown` default.                                                                                        | The copied worker lifecycle.                                                                                                               |
| `internal/extension/`               | The extension producer modules (build config, declarations, distribution, workspace extensions, state usage), which don't use Nitro.                                    | Their current home under `nitro/host/`.                                                                                                    |

The audits estimate the net change, before verification:

- **Host build:** −900 to −1,300 production lines.
- **Development:** −800 to −1,000.
- **Output and runtime:** −300 to −400 now, more as upstream asks land.
- **Tests:** about −1,300 lines, with new behavior coverage.

## Integration contract

### Rolldown is an eve dependency, handed to Nitro

- `rolldown` is an exact `dependencies` entry of `eve`. Users never add it, and eve never relies on
  Nitro or Vite to supply it.
- The host spec carries `deps: { paths: { rolldown } }`, resolved from eve's own manifest. Nitro's
  builder, its oxc helpers, and prerender then use eve's copy.
- `bundler/rolldown.ts` and `scripts/rolldown.mjs` stay lazy:
  - they use `import type` from `"rolldown"`;
  - `rolldown` joins `EXTERNAL_PACKAGES`;
  - the vendor stamp records its version;
  - the `conditionNames` assertion stays;
  - hosted output never contains Rolldown.
- `AGENTS.md` principle 5 names `nitro` and `rolldown` and states the `deps.paths` rule.

Rejected alternatives:

- Rolldown as a peer dependency. It's a hidden prerequisite for every build, and it hands version
  choice to apps.
- Nitro auto-install. It mutates user projects and prompts in a TTY.

### eve never triggers Nitro on-demand installs

No eve configuration can reach `ensureDep` for a package eve has not supplied. Once skill files and
the bootstrap leave storage and inlined literals, eve's own graph imports neither `unstorage` nor
`db0`.

The hosted-graph plugin rejects authored imports of `nitro/storage`, `nitro/kv`, and
`nitro/database`:

- It uses `enforce: "pre"` and a `resolveId` filter, so it runs before Nitro's `runtime-deps`
  plugin.
- The error is precise and points to eve's memory and workspace APIs.

A packed-install scenario enforces this.

### Host configuration

- **`scanDirs: []`.** eve registers every handler, plugin, and task explicitly. This was verified
  on the RC: with `serverDir: false`, nothing is scanned, including the app's own `tasks/`.
- **Drop `_cli`, `createNitro(…, { watch: true })`, and `watchOptions`.** The rolldown builder
  ignores `watchOptions`, and the dev candidate closes after one build. Verify on a real dev build
  before deleting the test that pins `watchOptions`.
- **c12 isolation (decided: isolate).** On the beta, Nitro's c12 loaded the app root's
  `nitro.config` and `.nitrorc` into eve's host, and `.env` in dev. That matters for TanStack hosts
  that share a root. eve now passes `dotenv: false`, `rcFile: false`, and `packageJson: false`, and
  pins `compatibilityDate`.
  - c12 has no off switch for its main config file, so `configFile` points into eve's build
    directory.
  - eve's dev server already loads the app's `.env` files and sends them with each build request.
    Nitro's dotenv only ever reached the build child.
- **Instrumentation runs before the server graph through `entry`.**
  - A config-declared `build:before` hook, which runs after the preset's hooks, replaces
    `options.entry` with `#eve/instrumentation-entry`. Nitro's Cloudflare preset wraps its entry
    the same way.
  - A host plugin resolves and loads the wrapper. It awaits instrumentation, then dynamically
    imports the preset entry and re-exports its bindings, using `this.resolve` and `this.load` to
    read export names.
  - The `config.input` rewrite goes away.
  - This works on the beta and ships in the first PR.
  - `resolveNitroServerEntry` exists only in the RC. Re-check it in the bump if eve's output ever
    has more than one entry chunk.
- **One tsconfig resolver.** Use one eve policy for every build (host, authored, workflow) and set
  `typescript.tsconfigPaths: false`.
- **`builder: "rolldown"` stays explicit.** Without it, a host `vite.config` with `nitro()` would
  select the Vite builder.

### Build plugins

| Today                                                                                                                                                      | After                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Five `rollup:before` hooks that `unshift` plugins                                                                                                          | Entries in the ordered `host-plugins.ts` list, passed as `buildPlugins`. Keep the step and workflow side-effect `resolveId` hooks ahead of extension-mount resolution, as today.                              |
| `rollupConfig.plugins` from `createNitroBundlerConfig`                                                                                                     | The same single list. `enforce: "pre"` becomes meaningful.                                                                                                                                                    |
| Plugins with no filters (pseudo-packages, both prunes, optional engine, extension external, extension scope, authored asset, step and side-effect plugins) | Object hooks with `filter: { id }`, built from `rolldown/filter` helpers and case-insensitive on Windows. Extension-mount stays unfiltered because it needs every import. Filters work on Rolldown 1.2.9 too. |
| `externalizeDevelopmentWorkflowBundle`                                                                                                                     | Delete if a real dev build confirms it's a no-op. The dev graph imports the `nitroBuildDir` copy, not the externalized path.                                                                                  |
| `patchWorkflowTransformExcludePath`                                                                                                                        | Delete. No installed package defines `workflow:transform`.                                                                                                                                                    |
| Routing import specifier plugin, `normalizeGeneratedEsmImportSpecifiers`                                                                                   | Delete (fixed upstream). Windows integration tests cover it.                                                                                                                                                  |
| `MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME` filter                                                                                                           | Delete.                                                                                                                                                                                                       |
| Hand-written Rolldown and plugin shapes (`Record<string, unknown>`, `BundlerPluginShape`)                                                                  | Types from `"rolldown"` and `NitroBuildPlugin`.                                                                                                                                                               |

### Workflow artifacts as data

- `WorkflowBundleBuilder.build()` returns `{ stepsPath, workflowsPath, stepTargets }`.
- The host spec sets `noExternals` and the step-transform id set from that return value. Delete
  the `steps.mjs` regex parser and its eight path helpers.
- Write one workflow directory.
- Delete the per-run versioned-cache calls on fresh directories, rebuild invalidation, the re-sync
  hook, the unused `watch` field, the build queue, the `/.eve/workflow-cache/` and `/@fs/`
  handling, and the manual `routing.sync()`.
- Keep `workflows-handler.mjs` as a file. Nitro virtuals default to `moduleSideEffects: false`,
  and that handler registers queue handlers as top-level side effects.
- The three filename-to-step-id helpers stay separate. src and dist parity does not hold: the host
  helper maps `dist/src` to `src` and the driver helper does not. Unifying them would change step
  ids when eve's `dist` is neither in `node_modules` nor a declared workspace dependency.
- Verify the workflow `manifest.json` has no external reader before deleting it.

### Generated data uses `text:` and `bytes:`

- **Skill files** move from storage to a generated `#eve/skill-files` plugin:
  - file bytes load lazily through `bytes:` imports of digest-named staged files, so authored names
    never appear in specifiers;
  - the index loads through `text:`;
  - reads return a copy;
  - files over the size limit are indexed by size only;
  - there is no runtime re-hash.

  This removes `serverAssets`, `nitro/storage`, the `.bin` trick, the mtime workaround, and the
  `server` asset filter.

- **The bootstrap** loads manifest, metadata, sandbox artifacts, and model metadata through a
  `text:` import of a staged JSON file instead of inlined literals.
- **Authored `?raw` assets** that the host inlines as JS text get the same treatment if they're
  confirmed to be exposed to `replace`.

All of this works on the beta.

### Externals policy

These mechanisms overlap today:

- `traceDeps`
- `traceOpts.nft.paths`
- the optional-engine plugin
- the extension external-dependency plugin
- two prune plugins
- the output check
- `noExternals` writes after `createNitro`
- the dev `config.external` wrapper
- workflow-builder external lists in an unrelated file
- dev `traceDeps`/`traceOpts` that dev never uses

They become `externals-policy.ts`, computed once:

- **`traceDeps`:** author externals, configured engines, and extension dependencies as `dep*`.
  Production only.
- **`noExternals`:** the workflow step targets.
- **Substitutions in the hosted-graph plugin:** the sandbox-provider prune, the dev-runtime prune,
  and unconfigured optional engines kept external and untraced.

  Nitro's `builtinModules` was rejected for that last case. It's documented for modules the runtime
  provides, and using it here would be a misuse.

- **Output checks in the same plugin.** They map `nitro:traced/<n>/<id>` back to the import id and
  probe a configured external only when the rendered code imports the bare specifier. Match import
  syntax, not string literals. Never probe the hoisted package for a version-specific traced copy.
- **Extension dependencies (verified, deleted).** Both Nitro versions treat `dep*` entries as forced
  trace includes. A host build consuming an extension with an ESM-only dependency (the #2291 case)
  produced identical node and Vercel output with and without eve's extension external-dependency
  plugin and `traceOpts.nft.paths`, so both are gone.

### Workflow program runtime is installed, never discovered

Delete the computed-specifier fallback in `shared/workflow-sandbox.ts`:

- `workflow-sandbox-runtime-plugin.ts` already imports `run` statically and installs it for
  agents with workflow-program tools.
- Hosted output can't resolve the fallback, and under Rolldown 1.2.16 it folds into a literal.

`loadWorkflowSandboxModule` throws a precise error when nothing was installed. Tests install the
runtime explicitly. Verify whether dynamic agent configurations can add workflow-program tools that
the static manifest check misses; if they can, the spec must include the plugin for them.

### Runtime layer

- **One generated runtime plugin** replaces the bootstrap, world, sandbox, and tracing plugins that
  work through import side effects, `process.env`, and global symbols. Keep boot failures fatal:
  eve does not adopt async-plugin request gating, which would turn a crash at boot into a server
  that is up but rejecting requests.
- **Shutdown through Nitro.**
  - Delete `sandbox-shutdown-plugin.ts`'s own SIGINT/SIGTERM handler, `process.exit`, and the
    `installed` flag. Sandbox shutdown becomes a close hook.
  - srvx's graceful shutdown runs the close hooks, and the RC stops scheduled tasks on close, so the
    process exits on its own.
  - Align the budgets (srvx, sandbox, `eve start`), and set `gracefulShutdown` explicitly through
    the server-entry options if the default isn't enough.
  - `eve start` scrubs `CI` and `NITRO_UNIX_SOCKET` from the child environment. `CI` disables srvx's
    graceful shutdown, so close hooks don't run on SIGTERM. Verify this before relying on it.
- **Channel dispatch fixes,** which also apply on the beta:
  - Pass each background task to `event.waitUntil` immediately, with rejection logging. Today tasks
    registered after the handler returns, such as during a streamed body, are dropped.
  - Decode params safely. A malformed `%` must not become an unlogged 500. Use h3's
    `getRouterParams(event, { decode: true })`, which keeps `%2F` encoded (see
    [Decisions](#decisions)).
  - Precompute a `routeKey → channel` map instead of the linear search done twice per request.
  - Share one `#eve/route-config` virtual module instead of baking full config into every route
    module.
- **WebSocket routes** register as `GET`. A path that also has an HTTP GET uses
  `defineWebSocketHandler(hooks, httpHandler)`, so one handler owns both protocols.

### HEAD requests

A HEAD request reaches only a handler declared with the public `HEAD()` route helper. That is the
beta's behavior, and the RC's GET fallback must not change it.

- The route table knows every method declared for each path. Route codegen bakes the `Allow` set
  into each eve-generated GET handler that has no HEAD sibling, covering both channel and host
  handlers.
- Each of those handlers calls one shared `routes/method-guard.ts` before anything else. HEAD gets
  405 with `Allow`, in the RC's exact header format, and no handler, span, or stream starts.
- Guarding inside `dispatchChannelRequest` would be too late: it has already opened a span and
  resolved the bundle. A global middleware would need its own path matching, which is the parallel
  router the ownership boundary forbids.
- Explicit `HEAD()` routes are unchanged, because the RC prefers a registered HEAD route.
- On the beta, the router never sends HEAD to a GET handler. It answers 404 first. So eve also
  registers each guarded GET module for HEAD, where the guard rejects it. The bump drops that
  registration once Nitro serves HEAD from GET routes.
- Delete the worker-side `GET /eve/v1/dev/runtime-artifacts` route. The parent intercepts that
  path before it reaches the worker, and leaving it there is one HEAD exposure.
- The channel routes docs state the rule: declare `HEAD()` to answer HEAD.

### Vercel output

- **Up front, in the host spec:**
  - `functionRules` and the cron route from route-table intent;
  - for service builds, `output.serverDir` under `functions/eve/__server.func`. Adopt this only if
    the service scenarios prove the layout; otherwise keep today's copy step.
- **Leave the function runtime to Nitro's Vercel preset.** eve sets no `vercel.functions.runtime`.
  The beta picks the build machine's Node major, capped at its `SUPPORTED_NODE_VERSIONS`; the RC
  reads `package.json` `engines` first. Node 26 needs Nitro to add 26 to that list.
- **Fix the schedule consumer in service builds.** It's broken today: its `.func` falls outside
  eve's keep list and is deleted, and its route is rewritten to the shared server, which loses the
  queue trigger. Classify functions and routes by route-table intent, never by path text or `src`.
- **Delete `materializeVercelWorkflowFunctionOutput`.** Both Nitro versions now copy with
  `verbatimSymlinks`. Gate the deletion on the `app-runtime-dependencies` scenario from #1279.
- **Keep, as named shims:**
  - service cron path prefixing (upstream: a public cron path);
  - the service catch-all fallback (upstream: configurable or `serverDir`-derived fallback);
  - copying the host middleware (a Vercel services concern);
  - deployment-id staging (inherently post-build);
  - sidecar files.

### Development path

```text
dev server process (never loads Nitro, Rolldown, or authored code)
 ├─ listener → control routes → wait for a runner → RunnerManager.fetch / upgrade
 ├─ host supervisor (~170 lines, on RunnerManager)
 │    swapTo(host): runner.waitForReady() → manager.reload(runner, { drain: { timeout: Infinity } })
 │                  rollback = close the candidate; refcounts released via hooks.onClose
 │    recycle(): ready spare, else swapTo(current)
 │    crash: manager.onClose → queue swapTo(current) unless a newer swap is queued
 │    close(): destroy client sockets → manager.shutdown(15 s) → dispose hosts
 ├─ rebuild coordinator (semantics unchanged) on a narrow { swapTo, recycle, prepareSpare } port
 └─ build sessions: process per rebuild plus a spare; one-shot Nitro, no watchers or reload hooks
```

- **Vendored `env-runner` 0.3.**
  - Vendor its public subpaths, not private chunks, and re-export upstream types instead of
    hand-written declarations.
  - Delete the source patch.
  - Stamp srvx and crossws versions.
- **`EveDevRunner extends NodeWorkerEnvRunner`** with a 15-second shutdown default (about 15
  lines). The copied lifecycle goes.
- **One promise replaces the 100 ms polling** while waiting for a runner.
- **Delete dead and legacy paths:**
  - the two-phase activation `rollback()` that only tests call;
  - v1 pointer compatibility (pre-1.0, no legacy fallbacks);
  - the dead `dev:reload` cache clear;
  - stale `devServer` option stubs.
- **Restructure cleanup.**
  - `start-development-server.ts` uses one `AsyncDisposableStack`; confirm Bun supports it.
  - Port parsing moves to `ports.ts`.
  - One `isPathInsideOrEqual` helper.
  - The prune state machine becomes a coordinator-owned queue.
- **Derive the host fingerprint from the structural part of the host spec.** That fixes the missing
  connection-event and extension-mount inputs; verify with a test first.
- **Keep eve's Node↔Fetch bridge, trimmed.** Running srvx in the parent would need srvx vendored
  as a direct dependency, which the ownership boundary rules out.
- **Not used: Nitro's `createDevServer`.** It needs an in-process Nitro, swaps before readiness,
  stops after three retries, and reaches into env-runner's private `_beginExchange`.

### Runtime behavior policy

| Change                     | Decision                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| HEAD                       | 405 with `Allow` on GET-only paths; no handler runs. See [HEAD requests](#head-requests). |
| 405 for wrong methods      | Accept. Update tests and docs that expect 404.                                            |
| `FastResponse`             | Keep Nitro's default.                                                                     |
| CrossWS 0.4.17             | Send compression is now on by default. Confirm WebSocket conformance.                     |
| WebSocket upgrade fallback | Unchanged by the RC. Use the merged handler for shared paths, and raise it upstream.      |

## Tests

Use the `test-audit` skill for every test change.

| Suite                                                                                                 | Action                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create-application-nitro.scenario.test.ts` (1,122 lines, Nitro stub, hand-called hooks, fake plugin) | Replace with unit tests of `createHostSpec` and the route table, plus integration tests of the plugin factories. Delete the tests that pin hook names, private ids, `watchOptions`, `scanDirs`, or the fake `workflow:transform`. |
| `configure-nitro-routes.test.ts` (pins virtual ids)                                                   | Rewrite against the route table: methods, routes, loaded-handler behavior, and HEAD `Allow` sets.                                                                                                                                 |
| `external-dependency-output-check-plugin.integration.test.ts`                                         | Use RC-shaped fixtures: placeholders plus rendered code. Cover a bare import (probed), a traced copy (not probed), a missing import (rejected), and a config string (not an import).                                              |
| `app-runtime-dependencies.scenario.test.ts` (197 s)                                                   | Consolidate to three real builds and split the file. This removes the tier's long pole.                                                                                                                                           |
| `nitro-rolldown-packed.scenario.test.ts`                                                              | Replace with the packed host-build scenario.                                                                                                                                                                                      |
| `drained-nitro-dev-server.scenario.test.ts`                                                           | Rewrite as `host-supervisor.scenario` on real worker entries. Keep the guarantee tests, delete the drain-bookkeeping replays, and add close-with-open-stream and prompt-retirement cases.                                         |
| `start-development-server.test.ts` (mocks 15 modules)                                                 | Port and env tables as unit tests, the control handler through its factory, and a few lifecycle cases.                                                                                                                            |
| `instrumentation-entry.scenario.test.ts`                                                              | Keep the assertions on the `entry` mechanism. Add an output with more than one entry chunk.                                                                                                                                       |
| `bin-build-output.scenario.test.ts`                                                                   | Turn off Rolldown timing checks in eve's build and assert there are no warnings. That removes the stale marker.                                                                                                                   |
| `build-application`, `nitro-step-entry`, and `dev-authored-source-watcher` scenarios                  | Move to integration. They need no real subprocess.                                                                                                                                                                                |
| `compiled-vendor-assets.scenario.test.ts`                                                             | Stamp includes `rolldown`, `env-runner`, srvx, and crossws.                                                                                                                                                                       |
| `nitro-bundle-report.scenario.test.ts`                                                                | Accept `rolldown` as an added dependency.                                                                                                                                                                                         |

The audit expects scenario-tier time to stay roughly flat, near 459 s wall, while coverage moves from
implementation details to behavior.

## Docs, templates, and policy files

- **`AGENTS.md`:** principle 5, and a note under coding principles pointing to the foundation
  invariants.
- **`research/nitro-core-integration.md`:** mark its Rolldown staging, route registry, and
  workflow-entry sections as superseded or completed by this document, and update `last_updated`.
- **`docs/channels/mcp.mdx`:** skill files are embedded in the bundle.
- **Channel routes docs:** the HEAD rule and 405.
- **Docs for any behavior that needs a decision** below, once decided.
- **`apps/frameworks/tanstack`:** move the `nitro` pin to the RC in the bump PR.
- **After the first eve release on the RC:**
  - bump `apps/docs/registry.json` to `nitro@3.0.261029-rc` and `vite@8.3.5`;
  - bump `personal-agent-template`'s `rolldown` to `~1.2.16`;
  - let template lockfiles follow the eve version.
- **Docs changes:** use the `technical-writing` skill and run `pnpm docs:check`.

## Delivery

Three PRs plus a post-release pin change, built on a branch in `vercel/eve` so e2e runs with
secrets. The first two land on the beta and do most of the foundation work, so the bump lands on a
clean base and stays focused on what needs the RC.

1. **Host foundation (beta).**
   - Host spec, route table and route codegen (with the HEAD guard), workflow artifacts as data.
   - The externals policy and the hosted-graph plugin.
   - One ordered plugin list with filters, passed as `rolldownConfig.plugins`.
   - The `entry`-based instrumentation wrapper, if it works on the beta.
   - `scanDirs: []`; dropping `_cli`, watch, and `watchOptions`; `#eve/` ids.
   - Dead-code deletions; the spec-based fingerprint.
   - Test rewrites for these modules.
2. **Runtime, output, and dev correctness (beta).**
   - Skill files and the bootstrap through `text:`/`bytes:`; workflow-sandbox fallback deletion.
   - Channel dispatch fixes, WebSocket routes as `GET`.
   - Schedule consumer fix and route-intent classification; deleting `materialize`.
   - Environment scrub in `eve start`.
   - Dev deletions and restructuring that don't need env-runner 0.3.
   - Test tier moves and consolidation.
3. **The bump.**
   - `nitro` RC, exact `rolldown@1.2.16`, `deps.paths`.
   - `buildPlugins`; Rolldown types; the shared authored-plugin factory; one tsconfig resolver.
   - Traced placeholders in the output check; the authored storage guard; routing plugin and
     debug-name filter deletions.
   - Vendored `env-runner` 0.3, `EveDevRunner`, and the host supervisor on `RunnerManager`.
   - One generated runtime plugin and shutdown through close hooks.
   - The packed host-build scenario.
   - `AGENTS.md`, research docs, the tanstack framework pin, and a `patch` changeset with credit.
4. **Post-release pins:** registry, Vite, and templates.

Build each PR as ordered, individually reviewable commits. Upstream asks are filed as issues on
Nitro and env-runner, not as eve PRs.

### Provenance

Outside contributor @pi0 opened [#5167](https://github.com/vercel/eve/pull/5167), an independent
attempt at this migration. eve takes no code from it. These findings appear in that PR and were
re-verified against the RC source and Rolldown before this plan adopted them:

- traced placeholders;
- the 1.2.16 minify fold;
- the `replace` exposure of inlined data;
- shared `bytes:` arrays;
- the upstream Windows fix;
- socket-abort ordering.

Where this plan's design differs, it chooses its own approach. For example, it deletes the
workflow-sandbox fallback rather than hiding its specifier.

Thank @pi0 for the investigation in #5167 in the bump changeset and PR description. Close #5167 as
superseded once the bump merges.

## Validation

Run the narrowest tier that covers each boundary. The full integration, scenario, and e2e tiers run
in CI.

- **Packed install outside the workspace.** Install with npm and run a real host `eve build` and
  `eve dev`. Check:
  - eve declares `rolldown` and Nitro does not;
  - exactly one `rolldown` is installed;
  - `package.json` and the lockfile are byte-identical afterward;
  - there is no `Installing automatically` or deprecation output;
  - hosted output has no `rolldown` or `unstorage`;
  - an authored `nitro/storage` import fails with the documented error and installs nothing.
- **Generated data.**
  - Skill files round-trip byte for byte, including non-UTF-8 bytes, empty files and directories,
    names with `?` or `#`, and a path containing `import.meta.dev`.
  - Mutating a read result doesn't affect later reads.
  - An instruction containing `import.meta.dev` survives a production build unchanged.
- **Hosted graph.**
  - No `run` runtime for agents without workflow-program tools; it works for agents with one.
  - Only eve's schedule tasks are registered.
  - Instrumentation evaluates before the server graph, and Nitro selects the right server chunk.
- **Host spec.**
  - Unit tables cover dev versus prod differences, route precedence, CORS, HEAD `Allow` sets, and
    externals policy.
  - The fingerprint changes for every structural input and ignores workspace paths.
  - Step-id parity holds between src and dist.
- **Routing.** On a built and booted host:
  - HEAD on a GET-only streaming route returns 405 and never runs the handler;
  - an explicit `HEAD()` route answers;
  - wrong methods return 405 with `Allow`;
  - the shared HTTP/WebSocket path works;
  - malformed params are rejected cleanly;
  - `waitUntil` work registered during a streamed body completes;
  - Windows integration covers handler import paths.
- **Vercel.** Service and non-service scenarios cover functions, the schedule consumer function and
  its queue trigger, routes, crons with prefixes, the pinned runtime, and the flow function.
- **Development.** Supervisor scenarios on real workers cover:
  - readiness-gated swap with rollback;
  - the spare worker;
  - crash restart;
  - close with an open stream in under 1 s;
  - retirement within 1 s of the last exchange;
  - WebSocket upgrades through the 0.3 worker;
  - Bun.
- **Shutdown.** `eve start` SIGTERM runs close hooks once, including sandbox shutdown and the
  instrumentation flush, and exits within budget, with `CI` set in the parent.
- **`guard:invariants`.** Reject `rollup:before`, `nitro.options` writes outside the adapter,
  `#nitro/` ids in eve source, and imports of the deleted wrappers.
- **Rolldown 1.2.16.** Update the unresolved-import message assertions.
- **End to end.** `e2e-local` and `e2e-vercel` pass from the `vercel/eve` branch.

## Decisions

1. **c12 isolation: isolate.** eve's host no longer loads the app's `nitro.config`, rc file, or
   `.env` through Nitro. eve owns its host config, and env loading stays with eve's own
   environment handling.
2. **Param decoding: keep `%2F` encoded,** as h3's `decode: true` does. It's safer and matches h3.
   Authored handlers see different values for encoded separators.
3. **Service `serverDir`: try it in PR 2.** Keep it only if the service scenarios pass unchanged;
   otherwise keep today's copy step until the upstream fallback option exists.

## Upstream asks

- **Nitro:**
  - a `deps` switch that fails closed instead of auto-installing;
  - a c12 switch to skip the main config file, so frameworks don't need to point `configFile`
    somewhere else;
  - a WebSocket resolver that rejects unmatched upgrades, or protocol-typed route entries;
  - a supported pre-entry hook for asynchronous instrumentation;
  - a one-shot dev build that returns the worker entry, with the rolldown builder's `dev:reload`
    carrying `{ entry }`;
  - documenting that `watchOptions` doesn't apply to the rolldown builder;
  - the runner host exposed from a `nitro/*` subpath;
  - a Vercel public cron path and a configurable or `serverDir`-derived catch-all fallback;
  - Node 26 in the Vercel preset's `SUPPORTED_NODE_VERSIONS`, so apps can deploy on it;
  - optionally, waiting for running tasks on close.
- **env-runner:**
  - `reload(runner, { drain, ready })`, which waits for readiness and rejects without swapping;
  - a public wait-for-attach;
  - a drain shutdown budget;
  - a public exchange tracker for the WebSocket proxy.

## Tracked separately

Outside this migration; verify before fixing:

- The compiler treats `[param]` route segments as parameters, but rou3 matches them literally.
- Check whether HTTP keep-alive sockets delay `server.close()` when a drained runner retires.
