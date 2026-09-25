# @eve/bench

Terminal-Bench harness benchmarks for eve, run by a zero-dependency Node runner.

The package owns the harness under evaluation (`agent/`), pinned dataset locks
and task cohorts (`datasets/`), and the runner (`src/`). Tasks keep the
Terminal-Bench layout and reward contract, so results stay comparable with
published runs. See `research/eve-bench-runner.md` for the design.

## Prerequisites

- Node.js 24 and pnpm
- Docker
- model-provider credentials in the environment, such as `AI_GATEWAY_API_KEY`
- a built local eve package when using `--eve local`; run `pnpm build` from the
  repository root first

Everything below runs from this directory with `pnpm bench` (alias for
`node src/cli.ts`).

## Run

```bash
pnpm bench tasks sync                                   # fetch pinned datasets into .generated/datasets
pnpm bench tasks list --cohort smoke                    # print a cohort's task names

AI_GATEWAY_API_KEY=... pnpm bench run --model zai/glm-5.2 --cohort smoke --attempts 3 --concurrency 8
pnpm bench run --harness oracle --cohort smoke           # reference solutions; validates the runner, no model
pnpm bench run --model zai/glm-5.2 --task fix-git --eve 0.35.0   # benchmark a published eve release
pnpm bench run --harness oracle --task-dir ./path/to/task # run a local Terminal-Bench task

# Build and cache a local e0 snapshot without calling a model.
pnpm bench prepare --harness e0 --agent /path/to/internal-agents/agents/e0 \
  --model openai/gpt-5.6-terra

# Run one e0 smoke task. The source app must have installed workspace dependencies.
AI_GATEWAY_API_KEY=... pnpm bench run --harness e0 \
  --agent /path/to/internal-agents/agents/e0 \
  --model deepseek/deepseek-v4-pro --cohort smoke --task fix-git --job e0-deepseek

pnpm bench report <job> --format junit --out junit.xml
pnpm bench diff <base-job> <candidate-job>
```

Every command accepts `--json` and never prompts. Jobs live in
`.generated/jobs/<job>/`. Re-running the same job resumes only when the model,
harness, bundle provenance, dataset, tasks, and attempt count match. Invalid or
mismatched trial records fail closed instead of being overwritten. Ctrl-C
aborts in-flight trials and removes their containers.

Pass `--task-dir <path>` more than once to run one or more local Terminal-Bench
task directories. A local-only run does not sync a dataset and records its
dataset as `local`.

## How a trial runs

1. Pull the task's prebuilt image (or build `environment/Dockerfile` once).
2. Start one container, upload the harness bundle to `/installed-agent`, and
   run the harness command under the task's agent timeout.
3. Upload `tests/` and run `tests/test.sh` under the verifier timeout. The
   verifier always runs, so the reward reflects what the agent left behind.
4. Read `/logs/verifier/reward.txt`, copy `/logs/agent` and `/logs/verifier`
   to the trial directory, remove the container, and write `trial.json`.

## Reading results

A trial is scored only when it measured the harness. Otherwise `trial.json`
records `invalid` with a phase and reason, and the trial is excluded from
`resolved`, `meanReward`, and `diff`:

- `environment`: runner-owned work failed, such as the image pull or build,
  container start, uploads, or log download.
- `harness`: the harness ran but completed no model call (zero or missing token
  usage). This usually means broken credentials, adapter configuration, or
  startup, not a weak harness.
- `verifier`: the verifier wrote no reward, including verifier timeouts.

After one model call completes, crashes, agent timeouts, and wrong answers
count against the harness. Reports list every invalid attempt, JUnit marks them
as errors instead of failures, and `diff` shows invalid counts next to each
task. Resolve invalid attempts before comparing jobs; `pnpm bench report <job>
--fail-on-invalid` exits 1 when any remain, and CI applies it to every smoke job.

Usage is read on the host from each harness's own event log (`events.ndjson`
for eve and e0, `<cli>.jsonl` for pi, OpenCode, and Codex), so it survives agent
timeouts. Input tokens include cache reads and output tokens include reasoning.
`costUsd` is null when the harness reports no cost; the CLI competitors report
none for custom Gateway providers, so compare tokens rather than cost across
harnesses.

## Environment parity

Every harness's tool commands run with the task container's own environment:
the image's `HOME`, `PATH`, and `ENV`, starting in the task working directory.
Harness state lives only in harness-owned paths under `/installed-agent`
(`CODEX_HOME`, `PI_CODING_AGENT_DIR`, `OPENCODE_CONFIG`), so what an agent
installs or configures in the task survives into verification. The eve runner
restores the container's own `PORT`, `HOST`, and Nitro variables for agent
commands.

Each runner-owned log (`container.log`, `agent.log`, and `verifier.log`) is
capped at 64 MiB. The runner appends a truncation notice when a log exceeds the
cap.

Containers carry the labels `eve-bench=1`, `eve-bench.job=<job>`, and
`eve-bench.task=<task>`. Find any leftovers with:

```bash
docker ps -a --filter label=eve-bench=1
```

At the start of a job, the runner removes stale containers with the same
`eve-bench.job` label before starting new trials.

## Stress tests

Run the Docker-backed stress suite separately from the default test suite:

```bash
pnpm run test:stress
```

The suite requires Docker and takes about 30 seconds. It covers the happy path,
agent and verifier timeouts, a bad image, SIGINT abort and resume, and concurrent
trials.

## Harnesses

- `eve` (default): builds `agent/` against the local checkout (`--eve local`)
  or an exact published version, then packages the Nitro output and a small
  runner that drives the server over HTTP. Build eve from the repository root
  with `pnpm build` before using `--eve local`. For cache lookup, `prepare()`
  derives the local eve identity from `packages/eve/dist` instead of packing
  first. The cache lives in `.generated/cache/`. Each trial uploads the bundle
  and only the Linux Node binary matching the task container's architecture,
  for about 128 MB total.

  The agent's tools operate on the task working directory through
  `EVE_BENCH_TASK_WORKDIR`; Docker is the isolation boundary, so they bypass
  eve's nested sandbox on purpose.

- `e0`: snapshots an installed local e0 app and its source-backed `eve-code`
  extension. The bundle records source, dependency, and installed eve hashes.
  It preserves e0's instructions, coding capabilities, tools, skills, and
  authored worker model. The adapter replaces production sandbox and transport
  integrations with the task-container backend and a local eve channel. It
  removes production Connect configuration, channels, connections, schedules,
  instrumentation, and sandbox bootstrap. `--model` changes the root model,
  not e0's authored worker model.

- `pi`, `opencode`, and `codex`: prepare explicitly versioned CLI bundles on the
  host and route full provider-qualified model IDs through an HTTPS API base.
  Pass an exact `--version`. The default base is Vercel AI Gateway. Codex uses
  the Responses protocol; pi and OpenCode use chat completions. Hermes fails
  explicitly until a pinned Python/uv bundle and verified custom-provider
  routing are implemented.

- `oracle`: runs each task's `solution/solve.sh`. Use it to check the runner
  and as the reward ceiling.

Adding a harness means implementing `src/core/harness.ts` (prepare a
directory, return a command and env) and registering it in `src/cli.ts`.

## Agent tools

`src/tools/` exposes `run_bench`, `get_bench_result`, `diff_bench`, and
`list_bench_tasks` as eve `defineTool` definitions over the same core used by
the CLI. Their results use the same `JobResult`, `TaskDelta`, and task-list JSON
as the CLI. Add a file to an agent's `tools/` directory that re-exports a
definition by relative path, or copy the definition there.

## Datasets and cohorts

`datasets/<name>-<version>.json` pins a git URL, commit, and the task paths in
it. `datasets/cohorts/<name>.json` names a reviewed task subset and the reason
it exists. Compare base and candidate runs with the same cohort, model,
attempt count, and eve source.

## CI

`.github/workflows/bench.yml` runs the oracle smoke cohort on pull requests that
touch this package or its design document and requires every task attempt to
resolve. It uploads the job directory and `junit.xml` as artifacts.

The real-model `eve-smoke` job runs through `workflow_dispatch` or when the
`bench:eve` label is added to a pull request. It accepts `model` and `cohort`
inputs for manual runs and requires `AI_GATEWAY_API_KEY`, which is unavailable
to pull requests from forks. It uploads its job directory and can optionally
diff the result against a downloaded base-job artifact.

## Layout

- `agent/`: harness behavior under evaluation (model binding, instructions, tools)
- `src/core/`: runner library with no dependency on eve or third parties
- `src/harnesses/`: `eve`, `e0`, CLI competitors, and `oracle`
- `src/tools/`: eve tool definitions over the runner core
- `src/options.ts`: run options shared by the CLI and tools
- `src/cli.ts`: `eve-bench` CLI
- `datasets/`: locks and cohorts
- `.generated/`: datasets, bundle cache, and job output; never committed
