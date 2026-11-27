---
issue: TBD
status: proposed
last_updated: "2026-11-27"
---

# Harbor-native code benchmark setup

## Problem

`eve-code` is currently benchmarked through an external repository (`vercel-labs/eve-bench`) checked out over SSH (`EVE_BENCH_SSH_KEY`) in `.github/workflows/eve-code-benchmark.yml`. Keeping a custom benchmark runner outside this repository causes two recurring failure modes:

1. **Runtime drift from stock `eve`.** `eve-bench` re-implemented its own container sandbox backend, booted `eve` in dev mode (`EVE_DEV=1` / `localDev()`), and drove sessions through a custom HTTP/v27 wire client with synchronous per-event logging. A single bug in that custom sandbox backend (`close: stop` killing sibling commands on every `ensureSandboxAccess.release()`) sent `SIGKILL` (exit `137`) to hundreds of concurrent subagent and background bash commands, invalidating `deepswe-lean` measurements. Now that `eve` ships stock `HostSandbox` (`eve/sandbox/host`, #6942), the benchmark no longer needs a custom sandbox implementation.
2. **Unnecessary reinvention.** Both `swe-lean` and `deepswe-lean` are already Harbor datasets, and [`harbor-framework/harbor`](https://github.com/harbor-framework/harbor) already provides:
   - A built-in `eve` agent (`src/harbor/agents/installed/eve.py` + `eve_runner.mjs`) that runs any regular `eve` app (`harbor run -a eve --ak path=./app`) through `eve build` and `eve start`.
   - A built-in `vercel` environment (`src/harbor/environments/vercel/`) that mirrors/builds task Dockerfiles into Vercel Container Registry (`vcr.vercel.com`) and boots each trial natively as a Vercel Sandbox — plus `--env docker` for local runs.
   - Native support for `verifier.environment_mode = "separate"`, `[[verifier.collect]]`, phase-scoped network policies, named-file artifact downloads, and ATIF trajectories.
   - Built-in adapters for every peer harness we compare against: `pi`, `opencode` / `opencode-v2`, `fx`, `codex`, `claude-code`, `hermes`, and `oracle`.

Rebuilding a Harbor clone inside `vercel/eve` (~3,900 lines of custom Docker/Sandbox orchestration, tar parsing, TOML parsing, binary mirroring, and peer runners) duplicates what Harbor already owns and maintains. Instead, we should update Harbor's upstream `eve` integration for current `eve` v1.x + `HostSandbox` and keep only a regular stock `eve` app plus thin CI/reporting glue inside `vercel/eve`.

## Goals and non-goals

### Goals

- Retire the external `vercel-labs/eve-bench` dependency and `EVE_BENCH_SSH_KEY`.
- Benchmark `eve-code` as a regular, checked-in standalone `eve` app (`apps/benchmarks/code/eve-code-app/`) built with `eve build` and run in production mode on stock `HostSandbox` (`eve/sandbox/host`) and stock `eve/client`.
- Delegate task execution, container/Vercel Sandbox lifecycle, verifier isolation, and peer harness execution (`pi`, `opencode-v2`, `fx`, `codex`, `claude-code`, `hermes`, `oracle`) to `harbor-framework/harbor`.
- Preserve all existing CI and docs contracts: `/benchmark` comment commands (`.github/scripts/resolve-benchmark-request.mjs`), `report.json` compatibility with `.github/scripts/eve-code-docs-snapshot.mjs`, and `apps/docs/lib/evals/eve-code-benchmark.json`.
- Keep the code owned by `vercel/eve` tiny (~200 lines total: the 6-file `eve` app + thin CLI/report adapter).

### Non-goals

- Building or maintaining custom Docker/Vercel Sandbox trial orchestrators, tar parsers, TOML parsers, binary downloaders, or peer CLI runners inside `vercel/eve`.
- Adding benchmark-only runtime switches, telemetry hooks, or endpoints to `packages/eve`.

## Architecture

```text
GitHub Workflow / Local CLI (`vercel/eve`)
  ├── 1. Stage `apps/benchmarks/code/eve-code-app/` + pack workspace `eve` (`pnpm --filter eve pack`)
  ├── 2. Run `harbor run --env vercel` (CI) or `--env docker` (local)
  │        ├── agent `eve` (`--ak path=<staged-app>`, `--ak reasoning_effort=<level>`)
  │        │     └── `eve build` -> `eve start` -> stock `HostSandbox` (cwd = `HARBOR_TASK_WORKDIR`)
  │        │         -> stock `eve/client` (Basic auth on `EVE_HARBOR_TOKEN`) -> `session.end()`
  │        ├── peers: `pi`, `opencode-v2`, `fx`, `codex`, `claude-code`, `hermes`
  │        └── baseline: `oracle` (`solution/solve.sh`)
  │      (Harbor handles VCR/Vercel Sandbox, separate verifiers, collect hooks, named-file downloads, ATIF)
  └── 3. Summarize Harbor job results -> `report.json` (snapshot-compatible) + `comment.md`
```

### 1. Upstream updates in `harbor-framework/harbor`

Harbor's built-in `eve` adapter (`src/harbor/agents/installed/eve.py` and `eve_runner.mjs`) was written in June 2026 before `eve` v1.x, v27 session events, and `HostSandbox`. One small upstream PR brings it up to date:

- **Current `eve/client` API and v27 events:** update `eve_runner.mjs` from legacy `new Client({ host })` / `client.session()` / `step.completed` to `new Client({ baseUrl, auth })`, `client.sessions.create({ message })`, `delivery.stream()`, `session.end()` (ensuring `HostSandbox.onSessionEnd()` cleans up background processes before `SIGTERM`), and v27 events (`usage.recorded` including `delegated-late`, `model.settled`, `call.requested`, `call.completed`/`call.failed`, `content.completed`, `turn.settled`, `delivery.settled`, `session.ended`). Update `eve.py`'s ATIF converter to match.
- **Production auth on `eve start`:** generate an ephemeral per-run `EVE_HARBOR_TOKEN` (unless already provided), pass it to `eve start`, and authenticate `Client` with HTTP Basic (`harbor:<token>`). Apps using `eveChannel({ auth: [verifyHttpBasic...] })` work in real production mode without `EVE_DEV=1`, while apps using `auth: none()` ignore the header.
- **Task `WORKDIR` handoff:** execute `eve_runner.mjs` in the container's default `WORKDIR` (rather than `/installed-agent/eve-project`) and pass `HARBOR_TASK_WORKDIR` to `eve start` (which still runs with `cwd: projectDir`). Apps using `HostSandbox` open directly on `process.env.HARBOR_TASK_WORKDIR` with no `/workspace` symlink.
- **Reasoning effort option:** add `reasoning_effort` to `EveOptions` and forward `HARBOR_REASONING_EFFORT` to `eve build` and `eve start` alongside `HARBOR_MODEL`, matching `pi`, `opencode`, `fx`, `codex`, and `claude-code`.

### 2. Stock `eve` benchmark app in `vercel/eve`

`apps/benchmarks/code/eve-code-app/` is a regular, typechecked `eve` application with zero custom sandbox or wire code:

- `agent/agent.ts`: `defineAgent({ model, reasoning })` reading `HARBOR_MODEL` and `HARBOR_REASONING_EFFORT`.
- `agent/extensions/code.ts`: `export default code({})` from `eve/extensions/code`.
- `agent/channels/eve.ts`: `eveChannel` with `verifyHttpBasic` + `withAuthChallenges` against `EVE_HARBOR_TOKEN`.
- `agent/sandbox.ts`: stock `HostSandbox` from `eve/sandbox/host`, opening `cwd: process.env.HARBOR_TASK_WORKDIR` and unsetting `EVE_HARBOR_TOKEN`, `HARBOR_*`, and `EVE_AGENT_*`. `HostSandbox` natively strips `NODE_ENV`, `HOST`, `PORT`, `NITRO_*`, `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `VERCEL_*`, isolates bundled skills in `$EVE_SKILLS_DIR`, and injects `Current working directory: <cwd>`.
- `agent/tools/web_search.ts` and `agent/tools/web_fetch.ts`: `disableTool()` to match offline peers.
- `agent/instructions.md`: minimal instructions file (no `/workspace` reference).

To benchmark an unreleased PR commit of `vercel/eve`, the thin staging step runs `pnpm --filter eve pack` into a `.tgz` inside the staged app directory and points `package.json` at `"eve": "file:./eve.tgz"` so Harbor installs the exact PR build inside the container.

### 3. Thin `vercel/eve` wrapper and CI workflow

- **Local and CI entrypoint (~150 LOC):** stages `eve-code-app/` with the packed workspace `eve` tarball, invokes `harbor run` with the requested dataset (`swe-lean` or `deepswe-lean`), harnesses, model, reasoning, attempts, and environment (`vercel` in CI, `docker` locally), and translates Harbor's job output into `report.json` (matching `.github/scripts/eve-code-docs-snapshot.mjs`) plus `report.md` and `comment.md`.
- **PR comments and docs snapshots:** `.github/workflows/eve-code-benchmark.yml` posts/updates PR comments via `actions/github-script` with `github.paginate` and keeps the existing `eve-code-docs-snapshot.mjs` GraphQL signed-commit flow unchanged.

## Invariants

- **Stock `eve` runtime:** `eve-code` always runs from `eve build` + `eve start` on `HostSandbox` with production auth — never `EVE_DEV=1`, never a custom sandbox provider, never a `/workspace` symlink.
- **Credential isolation:** Task containers receive only inference keys (`AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), never `VERCEL_TOKEN` or `VERCEL_OIDC_TOKEN` (note: ensure Harbor's `auto_env` does not forward `VERCEL_OIDC_TOKEN` into task containers).
- **Truthful scoring and parity:** Verifier crash sentinels (`-1`) and incomplete trials remain distinct from `reward: 0` so incomplete runs never publish docs snapshots; all harnesses share the same dataset, task `WORKDIR`, reasoning effort, and offline web-tool policy.
- **Contract preservation:** `/benchmark` PR commands in `.github/scripts/resolve-benchmark-request.mjs` and the `report.json` contract in `.github/scripts/eve-code-docs-snapshot.mjs` stay backward-compatible.

## Rollout phases

1. **Phase 1 — Upstream Harbor `eve` PR ([harbor-framework/harbor#4505](https://github.com/harbor-framework/harbor/pull/4505)):** Update `src/harbor/agents/installed/eve.py` and `eve_runner.mjs` in `harbor-framework/harbor` for `eve` v1.x `Client`, v27 events, `EVE_HARBOR_TOKEN`, `HARBOR_TASK_WORKDIR`, and `HARBOR_REASONING_EFFORT` (and verify `opencode-v2` / `pi` / `fx` route `openai/gpt-6.2-sol` cleanly).
2. **Phase 2 — Stock `eve-code-app` + thin Harbor wrapper in `vercel/eve`:** Add `apps/benchmarks/code/eve-code-app/` and the ~150-line Harbor runner/report adapter under `apps/benchmarks/code/`, verifying `swe-lean` and `deepswe-lean` locally (`--env docker`) and on Vercel (`--env vercel`) across `eve`, `oracle`, and peers.
3. **Phase 3 — CI cutover:** Switch `.github/workflows/eve-code-benchmark.yml` from `vercel-labs/eve-bench` to `harbor run`, validate both `anthropic` and `openai` (`openai/gpt-6.2-sol`) legs, retire `EVE_BENCH_SSH_KEY`, and remove the unused `packages/eve-code/agent/` directory (currently kept only for `eve-bench`'s `stat` check).

## Open questions

1. **Prebuilt `eve-code` vs in-container `eve build`:** Harbor's `eve.py` currently runs `npm install` + `eve build` per trial (or once via `--install-only` + `--ak skip_install=true`). Should CI use Harbor's `--install-only` snapshot flow so `npm install` + `eve build` runs once per job instead of per trial?
2. **Dataset pinning:** Keep referencing `swe-lean` and `deepswe-lean` from Harbor's dataset registry / pinned task paths, or check a tiny manifest in `apps/benchmarks/code/` pinning exact dataset revisions and `deepswe-lean` timeout/env overrides?
3. **`VERCEL_OIDC_TOKEN` in Harbor's `Eve._AUTO_ENV_PACKAGE_KEYS`:** Harbor's `eve.py:114` currently maps `@ai-sdk/gateway` to `{"AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"}`. Should our upstream PR (or `--ak auto_env=false`) avoid forwarding `VERCEL_OIDC_TOKEN` when `AI_GATEWAY_API_KEY` is already set so task containers never receive Vercel OIDC credentials?
