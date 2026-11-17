# Agent evals

Validation has three separate tiers:

- `pnpm test:runtime` compiles and runs the production browser workflow in an
  isolated Eve app with deterministic model responses. It checks structured
  completion, worker continuation, and cancellation of an active child tool.
  It needs no Gateway key, Kernel key, database, or Docker service. CI runs it
  after `pnpm check`. Reports are saved under `.eve/runtime-smoke/`.
  The runner copies current production tool source on each run; it does not
  maintain a second implementation. This tests Eve lifecycle behavior, not
  model judgment or real browser interaction.

- `agent/` is the behavioral regression suite for the root coordinator. It
  covers conversation quality, tool routing, safety and approval boundaries,
  memory isolation, personal information, scheduled execution and reporting,
  and worker orchestration.
- `browser/` is the slower end-to-end browser benchmark. It exercises real
  sites and records benchmark-specific timing, cost, and completion artifacts.

Directories are the grouping and filtering boundary. Each `.eval.ts` file owns
one behavior family, and array cases within a file share the same setup without
hiding their individual descriptions in the runner output.

## Running the suites

List every discovered case without making model calls:

```sh
pnpm eval:list
```

Run the root-agent suite locally, including soft judge thresholds as failures:

```sh
pnpm eval:agent
```

Run one family while iterating:

```sh
pnpm eval:agent --tag safety
pnpm eval:agent --tag routing
```

Produce JUnit output for CI:

```sh
pnpm eval:ci
```

The agent command loads `.env.local`, starts an isolated Docker Compose
PostgreSQL service, runs migrations, executes the suite, and then stops the
service. It requires `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`; the behavior
suite forces an unusable Kernel placeholder because browser work belongs in the
separate benchmark. Its Kernel and application callback origins are pinned to an
unreachable loopback address so worker-routing evals cannot reach the external
browser service and background callbacks cannot escape the isolated target.
Agent cases run serially so memory cases cannot leak state into a concurrently
executing case, and memory cases remove their canaries.
Judge-backed cases use the judge model in `evals.config.ts`. Full
event streams and assertion details are written to `.eve/evals/`.

Run the browser benchmark separately because it uses Kernel, real websites,
and a longer completion loop:

```sh
pnpm bench:browser
```

See `browser/README.md` for benchmark suites, repetitions, A/B runs, and its
dashboard.

## What should be a gate

Use deterministic gates for observable contracts: the selected tool, a pending
approval, an absent secret canary, a required delivery, or a worker boundary.
Use the judge only for qualities that cannot be expressed safely as an exact
match, such as decisiveness, concise wording, or whether a free-form answer
actually satisfies the request. Judge thresholds are soft in Eve, so run this
suite with `--strict` when regressions should fail the command.

When a production failure appears, add the smallest sanitized reproduction to
the owning family. Add a new family only when it represents a genuinely new
contract. Avoid examples that can send, purchase, delete, or otherwise mutate
external state; approval evals should stop while the action is still pending.
