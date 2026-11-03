# eve/extensions/code

`eve/extensions/code` is an eve extension for coding work. It contributes `apply_patch`, `grep`, investigation and review skills, and sandbox tooling. Vercel credentials are brokered before each turn. GitHub instructions, the `pr` skill, and the authenticated `gh` tool live in [`eve/extensions/git`](../eve-git/README.md).

It ships inside the `eve` package. This private `@eve/code` workspace package is its source of truth: eve's build copies `extension/` into `packages/eve/src/extensions/code/extension` and publishes it with these entry points:

- `eve/extensions/code`: the extension
- `eve/extensions/code/sandbox`: sandbox bootstrap and credential helpers
- `eve/extensions/code/tools`: `apply_patch` and `grep`

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

Preparation ensures `gh`, installs wrappers for `gh`, `vc`, and `gh-signed-commit`, and installs TypeScript diagnostics. With `eve/extensions/git` configured for `github`, repositories requiring verified signatures use `gh-signed-commit` through its `gh` tool.

## Non-Connect escape hatch

Consumers with a PAT, benchmark token, or another credential provider can omit the corresponding connector and call `authenticateGitHub` or `authenticateVercel` from `eve/extensions/code/sandbox` in their own sandbox lifecycle. These helpers support firewall, command-delivery, and broker options for consumer-owned commands; they do not configure the extension's `gh` tool.

## Develop in this workspace

Rebuild eve after editing `extension/`; the local agent under `agent/` mounts the built `eve/extensions/code`:

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

The `typescript-compiler` development alias supplies the JavaScript compiler API used by the diagnostics worker test. The workspace's TypeScript 7 CLI remains the package typechecker. `prepack` builds the extension; installation does not run the extension CLI before the local framework has been built.

## Benchmarks

eve-code is benchmarked with [eve-bench](https://github.com/vercel-labs/eve-bench#readme) on the SWE-lean and DeepSWE-lean datasets. eve-bench owns datasets, execution, comparisons, and reports; this package keeps no benchmark runner of its own.

### In CI

The `eve-code` workflow benchmarks eve-code, opencode, and pi together, with one `Benchmark harness (<family>)` job per model family:

| Family      | Model                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| `anthropic` | `EVE_CODE_BENCH_MODEL` repository variable, default `anthropic/claude-sonnet-5.5` |
| `openai`    | `EVE_CODE_BENCH_OPENAI_MODEL` repository variable, default `openai/gpt-6.1-sol`   |

Every trial runs in its own Vercel Sandbox, up to 16 at a time per harness. Each harness is compared with its own latest result from `main` on the same dataset and model, never with another model's results. The report covers resolved tasks, latency, and token usage. It goes to the job summary and, on PRs, a PR comment.

| Trigger                                | Dataset      | Models                 | Publishes baselines |
| -------------------------------------- | ------------ | ---------------------- | ------------------- |
| PR that changes `packages/eve-code/**` | SWE-lean     | `anthropic`            | No                  |
| `/benchmark` comment on a PR           | chosen       | `anthropic`, or chosen | No                  |
| Push to `main` that changes eve-code   | SWE-lean     | `anthropic`            | Yes                 |
| Weekly, Monday 06:00 UTC, on `main`    | DeepSWE-lean | both, one after other  | Yes                 |
| Manual dispatch                        | chosen       | both, or chosen        | Only on `main`      |

Vercel Sandbox limits how fast a team can allocate vCPUs, so the two families never run at the same time: a run that covers both runs them one after the other, each with its own 120-minute job limit. Two benchmarks that start at the same time from different runs can still hit that limit and lose trials to HTTP 429 errors. A newer PR head or comment cancels an older PR run; runs on `main` queue behind each other instead.

PRs get their baselines from the eve-bench result store. SWE-lean baselines for `anthropic` come from every push to `main`. DeepSWE-lean baselines, and all `openai` baselines, come from the weekly run, so a PR's delta there can include eve-code changes merged since. The DeepSWE-lean results in the docs come from the `anthropic` report of the latest weekly or dispatched run on `main`.

Main accepts changes only through a pull request with passing required checks. So the `Refresh docs benchmark results` job does not commit the docs snapshot to `main`. It resets the `bot/eve-code-benchmark-snapshot` branch to `main`, commits the new `apps/docs/lib/evals/eve-code-benchmark.json` there, and opens or updates the `chore: refresh eve-code benchmark results` pull request with auto-merge on. Like the changesets Version Packages PR, that pull request is opened with `GITHUB_TOKEN`. GitHub holds its workflow runs until a maintainer approves them, so the required checks start only after a maintainer selects **Approve workflows to run** on it. A maintainer then approves the pull request, and auto-merge squashes it. The job opens no pull request when the snapshot is unchanged.

Comment `/benchmark [<dataset>] [model=<family>] [<harness>[,<harness>...]]` to run a benchmark on a PR. Every part is optional and can come in any order, for example `/benchmark`, `/benchmark codex,eve-code`, or `/benchmark deepswe-lean model=openai`. You need write access to the repository. A comment runs one model family, because each harness and dataset gets a single PR comment that the latest run replaces.

eve-bench keys stored results by the agent repository, which only an eve-code run provides. A run without `eve-code`, such as a `harness=opencode` dispatch or `/benchmark opencode`, only measures the harnesses it names. It reports to the job summary and posts no PR comment. It is not compared with stored results and does not publish. To re-baseline one competitor on `main`, dispatch it together with eve-code, for example `harness=eve-code,opencode`.

Each dataset's attempts per task (5 for SWE-lean, 3 for DeepSWE-lean) match its stored baselines. eve-bench compares only whole-dataset results with the same attempts, so changing the count means re-baselining every harness on both models.

### Locally

With [eve-bench](https://github.com/vercel-labs/eve-bench#readme) linked (`npm link` in its checkout), commit and push this checkout, then run:

```sh
eve-bench -a eve-code --agent-dir packages/eve-code --model openai/gpt-6-luna --reasoning low \
  --scope <vercel-team> --execution vercel-sandbox
```

Pass several harnesses to compare them in one run, for example `-a eve-code,opencode,pi`. Use `--task <name>` to run a single task. Local runs never publish to the result store.

### Investigating a failed trial

Trial sandboxes are deleted as soon as each trial finishes. Before deletion, eve-bench pulls each trial's logs and traces out of the sandbox and uploads them with the workflow artifact. To read them, point eve-bench at the CI run:

```sh
eve-bench trials logs https://github.com/vercel/eve/actions/runs/<id>
eve-bench trials logs https://github.com/vercel/eve/actions/runs/<id> --harness eve-code --task <task>
```

The report's Diagnostics section prints this command with the run URL filled in. Each model family uploads its own artifact, named `<dataset>-<harnesses>-<family>`, for example `deepswe-lean-eve-code+opencode+pi-openai`. For a run that covered both families, add `--artifact <name>` to the printed command so it reads only that family's trials. The download uses the GitHub CLI and needs read access to this repository. The raw files (`agent.log`, `events.ndjson`, `observability.ndjson`, `verifier.log`) are cached under `~/.cache/eve-bench/runs/`.
