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

pnpm bench report <job> --format junit --out junit.xml
pnpm bench diff <base-job> <candidate-job>
```

Every command accepts `--json` and never prompts. Jobs live in
`.generated/jobs/<job>/`; re-running with the same `--job` name resumes it,
skipping trials that already have a `trial.json`. Ctrl-C aborts in-flight
trials and removes their containers.

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
- `src/harnesses/`: `eve` and `oracle`
- `src/tools/`: eve tool definitions over the runner core
- `src/options.ts`: run options shared by the CLI and tools
- `src/cli.ts`: `eve-bench` CLI
- `datasets/`: locks and cohorts
- `.generated/`: datasets, bundle cache, and job output; never committed
