# Browser benchmarks

The benchmark grades the user's end goal with an independent LLM judge. Tool
choice and click sequences are diagnostic data, never pass conditions.

Run a smaller smoke slice of the real-site suite against the dev server:

```sh
BROWSER_BENCH_LABEL=baseline BROWSER_BENCH_SUITE=smoke pnpm bench:browser
```

Use repeated trials when making a speed decision (the default is one to avoid
surprise spend):

```sh
BROWSER_BENCH_LABEL=baseline BROWSER_BENCH_REPETITIONS=3 pnpm bench:browser
```

The live suite contains real public booking and purchase-boundary tasks across
movie tickets, restaurants, rail, hotels, retail, and vertical search. Every
task stops before the irreversible confirmation or before an unrelated
authentication, challenge, traveler-information, or payment prerequisite:

```sh
BROWSER_BENCH_SUITE=live pnpm bench:browser
```

Login- and CAPTCHA-required outcomes are intentionally out of scope. The `all`
suite runs every enabled real-site task, while `smoke` runs a smaller subset.

Target a deployment with the same suite:

```sh
BROWSER_BENCH_LABEL=baseline pnpm bench:browser --url https://your-deployment.example
```

The terminal table reports each completed task's success, agent duration, LLM
cost, and terminal message. Full results are written to
`.eve/browser-benchmarks/`; `latest.json` always points to the newest run.

Before changing the agent, preserve the baseline, then compare it with a new
run:

```sh
cp .eve/browser-benchmarks/latest.json .eve/browser-benchmarks/baseline.json
BROWSER_BENCH_LABEL=no-fixed-waits pnpm bench:browser
pnpm bench:compare .eve/browser-benchmarks/baseline.json .eve/browser-benchmarks/latest.json
```

Edit `evals/browser/tasks.ts` to add a small number of stable,
intent-level tasks. Every case declares the user's prompt and a goal-level
success rubric. The judge sees the task, worker result, and coordinator response;
a plausible but incomplete answer does not count. Agent time is measured from durable
`message.received` to the terminal `message.completed` event. LLM cost sums
`usage.costUsd` from every completed model step; a `~` prefix means at least one
step did not report cost.

## Two-revision A/B

Start the standalone local dashboard in its own terminal. It only reads the
latest status artifact and never starts, stops, or times out benchmark runs:

```sh
pnpm bench:dashboard
```

Open `https://eve-browser-bench.localhost`, then run an A/B suite from another
terminal. The dashboard updates as Eve schedules tasks, discovers root and
worker sessions, and records judged results, cost, duration, and tool counts.
The run index keeps completed and interrupted comparisons available, with a
table view for each run's task-level results.

The A/B runner checks out two revisions into temporary worktrees, starts an
isolated database and Portless Eve server for each, runs both revisions
concurrently against the same task array, compares the artifacts, then cleans
up. Each isolated database is seeded with the same synthetic contact and
address records in the existing encrypted vault so routine checkout forms do
not become benchmark blockers:

```sh
pnpm bench:ab <baseline-ref> <candidate-ref> --suite all --label "semantic browser loop"
```

Runs default to nine concurrent tasks per revision, so an A/B suite can execute
up to 18 tasks at once. Real flows default to a 15-minute per-task timeout. Use
`--task-timeout-minutes <n>` to change that budget, `--repetitions 3` for a less
noisy speed decision, `--max-concurrency <n>` to override parallelism, and
`--keep` to leave both Portless instances and worktrees running for inspection.
`--label "…"` records a short note in the run list and detail view. Combined
artifacts land under `.eve/browser-ab/<timestamp>/`.
