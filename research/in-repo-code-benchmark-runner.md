---
issue: TBD
status: proposed
last_updated: "2026-11-27"
---

# In-repo code benchmark runner

## Problem

`eve-code` is currently benchmarked through an external repository (`vercel-labs/eve-bench`) checked out over SSH (`EVE_BENCH_SSH_KEY`) in `.github/workflows/eve-code-benchmark.yml`. Keeping the runner outside this repository causes two recurring failure modes:

1. **Runtime drift from stock `eve`.** `eve-bench` re-implemented its own container sandbox backend, booted `eve` in dev mode (`EVE_DEV=1` / `localDev()`), and drove sessions through a custom HTTP/v27 wire client with synchronous per-event logging. A single bug in that custom sandbox backend (`close: stop` killing sibling commands on every `ensureSandboxAccess.release()`) sent `SIGKILL` (exit `137`) to hundreds of concurrent subagent and background bash commands, invalidating `deepswe-lean` measurements. Now that `eve` ships stock `HostSandbox` (`eve/sandbox/host`, #6942), the benchmark no longer needs a custom sandbox implementation.
2. **Cross-org friction.** Debugging regressions, updating peer model mappings (such as `openai/gpt-6.2-sol`), or aligning telemetry requires coordinated changes across two organizations and a dedicated SSH deploy key.

At the same time, simply porting a full Harbor-style orchestrator into `eve` — complete with custom TOML parsers, multi-arch binary mirroring, and binary tar validation for untrusted container directories — adds thousands of lines of brittle ceremony and unnecessary security surface.

This plan proposes a minimal, first-principles in-repo runner under `apps/benchmarks/code/` that benchmarks stock `eve` as users deploy it, preserves the full comparison matrix (`eve-code`, `opencode`, `pi`, `fx`, `codex`, `claude-code`, and `oracle`), and eliminates unnecessary machinery by design.

## Goals and non-goals

### Goals

- Own the code benchmark runner and `eve-code` benchmark app inside this repository (`apps/benchmarks/code/`), removing the `vercel-labs/eve-bench` checkout and `EVE_BENCH_SSH_KEY`.
- Run `eve-code` in production mode (`eve build`, `HostSandbox`, `eve/extensions/code`, `verifyHttpBasic`, stock `eve/client`) with zero `EVE_DEV=1` paths, zero custom sandbox providers, and zero `/workspace` symlinks.
- Preserve the full harness surface already supported by `.github/scripts/resolve-benchmark-request.mjs`:
  - Automatic comparison defaults: `eve-code`, `opencode`, `pi`, `fx`.
  - Frontier lab references: `codex`, `claude-code`.
  - Verifier sanity baseline: `oracle` (runs each task's `solution/solve.sh`).
  - Optional opt-in harnesses (for example `hermes`) via the same adapter contract.
- Preserve all existing CI and docs contracts: `/benchmark` comment commands (`resolve-benchmark-request.mjs`), `report.json` schema consumed by `.github/scripts/eve-code-docs-snapshot.mjs`, and `apps/docs/lib/evals/eve-code-benchmark.json`.
- Keep the runner small (~600–800 LOC target) by designing out whole categories of complexity instead of patching around them.

### Non-goals

- Building a general-purpose Harbor replacement for arbitrary third-party benchmarks or cloud backends.
- Hand-rolling binary archive parsers, TOML parsers, or GitHub REST comment clients.
- Adding benchmark-only runtime switches, telemetry hooks, or endpoints to `packages/eve`.

## Architecture and simplifying decisions

```text
GitHub Workflow / Local CLI (Host)
  ├── 1. Build stock eve-code app once (`eve build` -> `.output` + `eve/client`)
  ├── 2. Prepare 1 template snapshot (Docker + pinned peer CLIs + dataset + `.output`)
  └── 3. Run bounded trial pool (local Docker or N `persistent: false` Vercel Sandboxes)
            │
            ▼ (1 isolated sandbox/host per trial)
        [Agent container: real task WORKDIR, inference keys only]
          ├── eve-code : production `.output/server` + `HostSandbox` + stock `eve/client`
          ├── peer CLI : `pi` | `opencode` | `fx` | `codex` | `claude-code`
          └── oracle   : task's `solution/solve.sh`
            │  (stop/remove agent container; transfer only bounded named artifacts if separateVerifier)
            ▼
        [Verifier container (`--network none` when separate): `tests/test.sh` -> `reward.txt`]
            │  (read ONLY allowlisted named files with hard byte caps — no untrusted directory tar)
            ▼
        Host aggregates -> `report.json` + `report.md` + `comment.md`
```

### 1. Stock `eve` benchmark app on `HostSandbox`

`apps/benchmarks/code/eve-code-app/` is a real, typechecked standalone `eve` app checked into the repo — no string-templated code generation and no custom sandbox provider:

- `agent/agent.ts`: `defineAgent({ model, reasoning })` reading `EVE_CODE_BENCH_MODEL` and `EVE_CODE_BENCH_REASONING`.
- `agent/extensions/code.ts`: `export default code({})` from `eve/extensions/code`.
- `agent/channels/eve.ts`: `eveChannel` with `verifyHttpBasic` + `withAuthChallenges` against an ephemeral per-trial `EVE_BENCH_TOKEN`.
- `agent/sandbox.ts`: stock `HostSandbox` from `eve/sandbox/host`, opening `cwd: process.env.CODE_BENCH_TASK_WORKDIR` directly and unsetting only benchmark-specific env vars (`EVE_BENCH_TOKEN`, `CODE_BENCH_*`, `EVE_CODE_BENCH_*`). `HostSandbox` natively strips `NODE_ENV`, `HOST`, `PORT`, `NITRO_*`, `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `VERCEL_*`, isolates bundled skills in `$EVE_SKILLS_DIR`, avoids `close()`-on-release `SIGKILL`s, and injects `Current working directory: <cwd>` with the real container path (`/app` or `/testbed`).
- `agent/tools/web_search.ts` and `agent/tools/web_fetch.ts`: `disableTool()` to match offline peer configurations.
- `agent/instructions.md`: minimal required instructions file (no `/workspace` alias).

Inside the task container, a small runner boots `.output/server/index.mjs` without `EVE_DEV`, drives one turn via `Client` from `eve/client`, records `events.ndjson` + `result.json`, and shuts down via `session.end()` + `SIGTERM`.

### 2. Bounded named-file readback instead of untrusted directory archives

Copying entire container output directories via `tar` creates an unnecessary security and complexity surface (tar/gzip bombs, GNU/PAX sparse files, PAX `size` header desyncs, symlink traversal, and unbounded host memory buffering).

Instead, container and sandbox boundaries only transfer an explicit allowlist of small regular files with hard byte caps:

| File                                                           | Direction                   |         Cap | Purpose                                                                                |
| -------------------------------------------------------------- | --------------------------- | ----------: | -------------------------------------------------------------------------------------- |
| `trial.json`                                                   | Sandbox -> Host             |     256 KiB | Structured trial result (`reward`, `usage`, `overhead`, `status`, `error`)             |
| `agent/result.json`                                            | Container -> Worker         |       1 MiB | Harness telemetry and status                                                           |
| `verifier/reward.txt` (or `reward.json`)                       | Container -> Worker         |      64 KiB | Verifier score or `-1` crash sentinel                                                  |
| Declared `separateVerifier` artifacts (e.g. `model.patch`)     | Agent -> Verifier           | 16 MiB each | Regular files only (`! -L`), copied by explicit name                                   |
| Diagnostic logs (`events.ndjson`, `agent.log`, `verifier.log`) | Container -> Worker -> Host |  4 MiB each | Streamed directly with truncation marker; never archived/extracted via untrusted `tar` |

On Vercel Sandbox, the host reads those named files directly through `sandbox.readFile()` streams capped per file and bounded across concurrent downloads. Removing untrusted directory archiving eliminates all custom tar parsing by construction.

### 3. Snapshot-native peer installation (no CI-host binary mirroring)

Rather than downloading Linux `x64` and `arm64` Node and peer tarballs on the GitHub Actions runner and uploading hundreds of megabytes in `cache.tar.gz`:

- In Vercel Sandbox mode, one template sandbox installs Docker plus the pinned CLI versions for the requested harnesses once before snapshotting (`npm install --ignore-scripts` for `pi`, `codex`, `claude-code`; pinned releases for `opencode` and `fx`). The host uploads only the prebuilt `eve-code` `.output` and the active dataset's task metadata.
- In local Docker mode, the runner uses the local Docker daemon and caches only the host/container arch needed for the selected harnesses.

### 4. Standard parsers and repo-native workflow plumbing

- **Dataset parsing:** Parse upstream `task.toml` with a standard existing TOML `devDependency` (or a checked-in JSON task manifest generated from pinned dataset commits) instead of a custom TOML parser.
- **Harness adapter contract:** Every harness (`eve-code`, `opencode`, `pi`, `fx`, `codex`, `claude-code`, `oracle`) implements one small uniform contract: install/stage assets, launch command with uniform `CODE_BENCH_*` env, and normalize telemetry into `result.json`. `oracle` runs each task's `solution/solve.sh` directly inside the task container.
- **PR comments and docs snapshots:** Post and update PR comments via `actions/github-script` with `github.paginate` in `.github/workflows/eve-code-benchmark.yml` (matching `bundle-analysis.yml` and `docker-image-size-analysis.yml`), and keep `report.json` byte-compatible with `.github/scripts/eve-code-docs-snapshot.mjs` and its GraphQL `createCommitOnBranch` signed-commit flow.

## Invariants

- **Credential isolation:** Task containers receive only inference credentials (`AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) — never `VERCEL_TOKEN`, `VERCEL_OIDC_TOKEN`, or repository secrets.
- **Cross-harness fairness:** Every harness runs in the same task container image, real `WORKDIR`, timeout budget, reasoning effort, and offline web-tool policy. Containers start with `--init --entrypoint ""`; agent timeouts terminate the in-container process group before collect hooks or verification run. For `separateVerifier` tasks, `agentContainer` is removed before starting the `--network none` verifier container to bound peak disk and RAM.
- **Truthful scoring and telemetry:**
  - Verifier `-1` crash sentinels, empty files, and out-of-range values map to `reward: null` (`incomplete`), never `reward: 0`.
  - Peer API errors that still exit `0` (such as `pi --mode json` assistant `stopReason: "error"`) record `status: "failed"`.
  - Token accounting is consistent across harnesses: OpenCode includes reasoning tokens, `fx` rolls up `subagents[].usage`, and `eve-code` includes `delegated-late` usage and `delivery.settled` failure outcomes (`failed`, `refused`, `awaiting-input`).
  - Runs where 100% of trials fail without a reward exit non-zero in CI.
- **Deterministic sandbox cleanup:** Every Vercel Sandbox is created with `persistent: false`, retried with backoff on HTTP `429`, and torn down with `stop()` + `delete({ deleteOrphanSnapshots: true })` in `finally` and on `SIGINT`/`SIGTERM`. Template snapshots use a 24-hour expiration and are deleted when the run ends. Reports persist progressively as trials finish.

## CLI surface

```sh
pnpm --filter @eve-internal/benchmarks code-bench \
  --dataset swe-lean|deepswe-lean \
  --harness eve-code,opencode,pi,fx \
  --model anthropic/claude-sonnet-5.5 \
  --reasoning low|high \
  --attempts 5 \
  --concurrency 16 \
  --backend docker|vercel-sandbox \
  --output benchmark-results
```

## Rollout phases

1. **Phase 1 — Local Docker vertical slice (`eve-code` + `oracle`):** Add `apps/benchmarks/code/eve-code-app/` (stock `HostSandbox`) and the minimal local Docker runner with bounded named-file readback. Verify `oracle` passes 100% of `swe-lean` and `eve-code` runs cleanly end-to-end.
2. **Phase 2 — Vercel Sandbox fan-out, peer adapters, and `deepswe-lean`:** Add snapshot-native peer installation (`pi`, `opencode`, `fx`, `codex`, `claude-code`), `separateVerifier` support, bounded Vercel Sandbox worker pool, and `report.json` compatibility tests against `.github/scripts/eve-code-docs-snapshot.mjs`.
3. **Phase 3 — CI cutover:** Switch `.github/workflows/eve-code-benchmark.yml` from `vercel-labs/eve-bench` to `apps/benchmarks/code/`, validate both `anthropic` and `openai` (`openai/gpt-6.2-sol`) legs on `swe-lean` and `deepswe-lean`, retire `EVE_BENCH_SSH_KEY`, and remove the unused `packages/eve-code/agent/` directory (currently kept only for `eve-bench`'s `stat` check).

## Open questions

1. **Task definition source:** Should we keep pulling `swe-lean` / `deepswe-lean` task definitions from pinned upstream git commits at run time, or check in a compact JSON task manifest under `apps/benchmarks/code/datasets/` so CI has zero external git fetches?
2. **Harbor CLI vs thin Docker wrapper:** `swe-lean` and `deepswe-lean` use Harbor's `task.toml` + `tests/test.sh` convention. Owning a ~120-line Docker lifecycle wrapper avoids a Python runtime dependency inside Vercel Sandboxes, whereas shelling out to Harbor tracks upstream dataset schema changes automatically. Which tradeoff do we prefer?
3. **Gateway vs provider-native keys for `codex` and `claude-code`:** When `/benchmark codex` or `/benchmark claude-code` runs in CI, should both route through Vercel AI Gateway (`AI_GATEWAY_API_KEY`) for uniform model routing, or use direct provider keys when present?
