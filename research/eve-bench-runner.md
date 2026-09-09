---
issue: TODO
status: approved
last_updated: "2026-09-09"
---

# eve-bench: a zero-dependency benchmark runner

`packages/eve-bench` currently benchmarks the eve harness on Terminal-Bench
through Harbor: a Python adapter subclasses Harbor's private `Eve` agent, a
Node runner drives the built app, and a materialization script produces a
self-contained app directory (two Node binaries, a rolldown bundle, `npm ci`)
because Harbor copies the agent directory into every task container.

That stack needs three runtimes (Python, Harbor at a pinned revision, Node),
leaks Harbor-specific env (`HARBOR_MODEL`, `EVE_HARBOR_TASK_WORKDIR`) into the
harness under test, breaks on any upstream refactor of Harbor's private
methods, and has no path to a CLI, an agent tool, or a GitHub Action that
does not drag Python along.

Per trial, Harbor does five things: resolve a task directory, run a Docker
container, exec the agent under a timeout, exec `tests/test.sh` under a
timeout and read `/logs/verifier/reward.txt`, and write a result record. A
job is that loop over tasks × attempts with concurrency and resume. All of it
fits in a small amount of Node with no third-party dependencies.

## Proposal

Replace Harbor with an eve-owned runner. Keep the Terminal-Bench task format
and reward contract unchanged so datasets stay interchangeable and results
remain comparable with published Harbor runs.

```
packages/eve-bench/
  src/core/            zero-dependency library; does not import eve
    task.ts            load task.toml + instruction.md
    docker.ts          container lifecycle over the docker CLI
    trial.ts           run one attempt: start → agent → verify → record
    job.ts             matrix, concurrency, attempts, resume
    result.ts          trial/job JSON schema
    report.ts          console, json, junit, diff
  src/harnesses/eve/   the eve harness: build once, exec in container
  src/harnesses/       oracle (reference solutions) and future harnesses
  src/cli.ts           eve-bench run | tasks | report | diff
  src/tools/           eve tools wrapping core for agent consumers (follow-up)
  datasets/            pinned dataset locks and cohorts (JSON)
  agent/               the harness under test (unchanged)
```

The runner is plain `.ts` executed by Node 24 with type stripping; the root
tsconfig already enforces `erasableSyntaxOnly`. No build step, no bundler.

### Datasets

A dataset lock pins a git remote, commit, and the task paths within it:

```json
{
  "name": "terminal-bench",
  "version": "2.0",
  "gitUrl": "https://github.com/laude-institute/terminal-bench-2.git",
  "commit": "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c",
  "tasks": ["adaptive-rejection-sampler", "fix-git", "..."]
}
```

`eve-bench tasks sync <lock>` clones the pinned commit (shallow, sparse) into
`.generated/datasets/<name>-<version>/`. Cohorts are named task subsets in
`datasets/cohorts/*.json` and reference a lock by name; membership changes
are reviewed like code.

### Tasks

A task is a Terminal-Bench directory: `task.toml`, `instruction.md`,
`environment/Dockerfile` (optionally with a prebuilt `docker_image`),
`tests/test.sh`, `solution/`. The loader reads only what the runner needs:

- `task.name`
- `agent.timeout_sec`, `verifier.timeout_sec`, `environment.build_timeout_sec`
- `environment.docker_image`, `cpus`, `memory_mb`, `allow_internet`

`task.toml` is parsed by a minimal TOML reader covering the subset the
dataset uses (tables, strings, numbers, booleans, arrays). Anything outside
that subset is a load error naming the line.

### Environment

One container per trial, always via the `docker` CLI. Prebuilt
`environment.docker_image` is preferred; otherwise the Dockerfile is built
once per task and cached by image tag. Every operation (`build`, `run`,
`exec`, `cp`, `rm`) accepts an `AbortSignal`; SIGINT to the runner aborts
in-flight trials and removes their containers before exiting.

### Harness contract

A harness is something that can be placed in a container and told to solve
an instruction. It is a spawned shell, nothing more:

```ts
interface Harness {
  readonly name: string;
  /** Runs once per job on the host; returns a directory to place in the container. */
  prepare(ctx: { model: string; cacheDir: string }): Promise<{ dir: string; provenance?: object }>;
  /** Optional per-task host paths uploaded into the install directory. */
  stage?(ctx: { taskDir: string }): readonly string[];
  /** Shell command executed inside the container in the task working directory. */
  command(ctx: {
    installDir: string;
    instructionPath: string;
    taskWorkdir: string;
    logsDir: string;
  }): string;
  /** Env visible to the command. Provider credentials are forwarded by the runner. */
  env(ctx: { model: string }): Record<string, string>;
}
```

The bundle directory is uploaded to `/installed-agent`. The eve harness
bundles the Nitro output built from `agent/`, a runner, and Linux Node
binaries, cached by content hash of `agent/`, the eve source, and the model.
The runner drives the server over plain HTTP (`POST /eve/v1/session`, then
`GET /eve/v1/session/:id/stream`), so the bundle carries no `node_modules`
and no bundler is involved. It writes `/logs/agent/events.ndjson` and
`/logs/agent/result.json`. The env the harness reads is `EVE_BENCH_MODEL` and
`EVE_BENCH_TASK_WORKDIR`.

An `oracle` harness runs each task's `solution/solve.sh` via `stage`. It
validates the runner without a model and is the reward ceiling a real harness
is measured against. A harness wrapping another CLI agent is the same
interface and enables side-by-side comparison.

### Trial lifecycle

```
resolve task ─▶ start container ─▶ upload harness ─▶ exec harness (agent timeout)
                                                              │
      record ◀── read reward.txt ◀── exec tests/test.sh ◀─────┘
                                     (verifier timeout)
```

The verifier always runs, including after an agent timeout or failure, so a
trial's reward reflects the filesystem the agent left behind. Container
removal is unconditional. Each trial writes to its own directory:

```
.generated/jobs/<job>/<task>/<attempt>/
  trial.json         the result record below
  agent/             copied /logs/agent
  verifier/          copied /logs/verifier
  container.log      docker output for the trial
```

Resume skips trial directories that already contain a `trial.json`.

### Result schema

```ts
interface TrialResult {
  readonly task: string;
  readonly attempt: number;
  readonly harness: string;
  readonly model: string;
  readonly reward: number | null; // null when the verifier produced none
  readonly agent: StepResult;
  readonly verifier: StepResult;
  readonly usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number;
  };
  readonly error?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

interface StepResult {
  readonly status: "completed" | "timeout" | "failed" | "skipped";
  readonly exitCode: number | null;
  readonly durationMs: number;
}

interface JobResult {
  readonly job: string;
  readonly dataset: { name: string; version: string; commit: string };
  readonly harness: string;
  readonly model: string;
  readonly trials: readonly TrialResult[];
  readonly summary: { tasks: number; attempts: number; resolved: number; meanReward: number };
}
```

This schema is the API. The CLI, the GitHub Action, and agent tools all read
and write it; nothing else is stable.

### CLI

```
eve-bench tasks sync <lock>                     fetch a pinned dataset
eve-bench tasks list --cohort smoke             print task names
eve-bench run --cohort smoke --model zai/glm-5.2 [--attempts 3] [--concurrency 8] [--task fix-git ...]
              [--harness eve|oracle] [--eve local|<version>] [--job <name>]   # same --job resumes
eve-bench report <job> [--format console|json|junit]
eve-bench diff <base-job> <candidate-job>       per-task reward deltas
```

Every command accepts `--json` and never prompts. Provider credentials come
from the environment (`AI_GATEWAY_API_KEY`) and are forwarded into the
container only for the harness exec, never written to disk.

### Consumers

- CI: a workflow runs `eve-bench run --cohort smoke --json`, uploads the job
  directory as an artifact, and posts `eve-bench diff` against the base
  branch's artifact.
- Humans: the same CLI with the console reporter.
- Agents: `src/tools/` exposes `run_trial`, `get_result`, and `diff` as eve
  tools over `core`; they return the schema above.

## Invariants

- `src/core` has no dependency on `eve` or any third-party package; only the
  eve harness imports eve.
- Task format, verifier contract, and reward semantics are Terminal-Bench's;
  eve-bench adds nothing to a task directory.
- A harness never sees runner internals beyond the contract above.
- Trial directories are append-only; resume never rewrites a `trial.json`.

## Out of scope

- Non-Docker environments (Vercel Sandbox, remote runners). The `docker.ts`
  surface is small enough to add a second implementation later; it is not
  abstracted ahead of need.
- Reusing eve's `SandboxBackend` for the environment. The benchmark must not
  depend on the surface it measures.
- Uploading results to a hosted dashboard.
- `src/tools/` (eve tools over `core`) and the CI workflow. Both consume the
  result schema above and follow once the CLI has run a full dataset.
