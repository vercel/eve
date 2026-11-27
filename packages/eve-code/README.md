# eve/extensions/code

`eve/extensions/code` is an eve extension for coding work. It contributes coding instructions for eve's default file tools, the workspace root's `AGENTS.md` or `CLAUDE.md` as project instructions, investigation and review skills, and sandbox tooling. Vercel credentials are brokered before each turn. GitHub instructions, the `pr` skill, and the authenticated `gh` tool live in [`eve/extensions/git`](../eve-git/README.md).

It ships inside the `eve` package. This private `@eve/code` workspace package is its source of truth: eve's build copies `extension/` into `packages/eve/src/extensions/code/extension` and publishes it with these entry points:

- `eve/extensions/code`: the extension
- `eve/extensions/code/sandbox`: sandbox bootstrap and credential helpers

## Mount

```ts
// agent/extensions/code.ts
import code from "eve/extensions/code";

export default code({
  // Optional; omit to mount without Connect-backed Vercel authentication.
  vercel: { connector: "vercel/acme-bot" },
});
```

The Vercel connector is optional; `code({})` mounts without it. The Vercel connector requests an app-subject token. Firewall delivery is the default and keeps tokens outside sandbox processes; without a consumer `broker`, it requires a sandbox provider that exposes `setNetworkPolicy()` and fails otherwise. Use `delivery: "command"` on the Vercel connector for providers without mutable network policy. A top-level `broker(sandbox, rules)` callback lets the consumer merge Vercel credential rules into its own network policy.

The retired `github` option is rejected. Configure `eve/extensions/git` for GitHub tools, instructions, and the pull request skill.

The removed `worker` option is rejected with a migration hint. Delegate with eve's built-in `agent` tool.

## Sandbox bootstrap

Install CLI tooling in the environment's `prepare` callback:

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import { installCodeTooling } from "eve/extensions/code/sandbox";

export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await installCodeTooling(sandbox, { vercel: true });
  },
});

export default defineSandbox(() => environment.open());
```

eve derives the prepared environment generation from the sandbox file and environment options, not from imported helpers, so upgrading eve alone does not rebuild an existing prepared artifact.

Computer use lives in its own extension. Import its tools and sandbox helpers directly; the deprecated code re-exports are removed.

Preparation ensures `gh` and installs wrappers for `gh`, `vc`, and `gh-signed-commit`. With `eve/extensions/git` configured for `github`, repositories requiring verified signatures use `gh-signed-commit` through its `gh` tool.

## Non-Connect escape hatch

Consumers with a PAT, benchmark token, or another credential provider can omit the corresponding connector and call `authenticateGitHub` or `authenticateVercel` from `eve/extensions/code/sandbox` in their own sandbox lifecycle. These helpers support firewall, command-delivery, and broker options for consumer-owned commands; they do not configure the extension's `gh` tool.

## Develop in this workspace

Rebuild eve after editing `extension/`:

```sh
pnpm build:eve
pnpm typecheck --filter=@eve/code
pnpm test:unit --filter=@eve/code
pnpm test:integration --filter=@eve/code
pnpm test:scenario --filter=@eve/code
pnpm exec oxlint packages/eve-code
pnpm exec oxfmt --check packages/eve-code
```

Tests live under `test/`, outside the extension distribution. Unit and integration tests run through the workspace's matching test tasks. Turbo builds eve once before the integration tasks that import its runtime files. Scenario tests exercise temporary files, local Git repositories, and subprocesses; they need Node.js 24 or newer, Git, and Bash, but no model or service credentials.

`prepack` builds the extension; installation does not run the extension CLI before the local framework has been built.

## Benchmarks

eve-code is benchmarked with the in-repo runner under `apps/benchmarks/code/` on the `swe-lean` and `deepswe-lean` datasets.

### In CI

The `eve-code` workflow benchmarks `eve-code`, `opencode`, `pi`, and [fx](https://fx.sh) together, with one `Benchmark harness (<family>)` job per model family:

| Family      | Model                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| `anthropic` | `EVE_CODE_BENCH_MODEL` repository variable, default `anthropic/claude-sonnet-5.5` |
| `openai`    | `EVE_CODE_BENCH_OPENAI_MODEL` repository variable, default `openai/gpt-6.2-sol`   |

Every trial runs in its own Vercel Sandbox, up to 24 at a time. The report covers resolved tasks, latency, and token usage. It goes to the job summary, uploads as a workflow artifact, and updates the PR comment on pull requests.

| Trigger                                                             | Dataset        | Models                 |
| ------------------------------------------------------------------- | -------------- | ---------------------- |
| PR that changes `packages/eve-code/**` or `apps/benchmarks/code/**` | `swe-lean`     | `anthropic`            |
| `/benchmark` comment on a PR                                        | chosen         | `anthropic`, or chosen |
| Push to `main` that changes `eve-code` or the runner                | `swe-lean`     | `anthropic`            |
| Weekly, Monday 06:00 UTC, on `main`                                 | `deepswe-lean` | both, one after other  |
| Manual dispatch                                                     | chosen         | both, or chosen        |

Vercel Sandbox limits how fast a team can allocate vCPUs, so the two families run sequentially, each with a 180-minute job limit. A newer PR head or comment cancels an older PR run; runs on `main` queue behind each other instead.

The DeepSWE-lean results in the docs come from the `anthropic` report of the latest weekly or dispatched run on `main`. The `Refresh docs benchmark results` job updates `apps/docs/lib/evals/eve-code-benchmark.json` on `bot/eve-code-benchmark-snapshot` and opens or updates a PR with auto-merge enabled.

Comment `/benchmark [<dataset>] [model=<family>] [<harness>[,<harness>...]]` to run a benchmark on a PR (for example `/benchmark`, `/benchmark eve-code,pi`, or `/benchmark deepswe-lean model=openai`). You need write access to the repository.

### Locally

Build `eve` first, then run locally in Docker (or pass `--execution vercel-sandbox`):

```sh
pnpm build:eve
pnpm --filter @eve-internal/benchmarks code-bench \
  --dataset deepswe-lean --harness eve-code --model openai/gpt-6.2-sol \
  --task anko-typed-variable-bindings --attempts 1 --execution local
```

Pass `--harness eve-code,opencode,pi,fx` to compare harnesses head-to-head. Trial outputs (`trial.json`, `agent/events.ndjson`, `agent/result.json`, `agent/server.log`, `verifier/reward.json`, `verifier.log`) are written under `--output` (default `benchmark-results/`).
