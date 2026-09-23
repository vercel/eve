# eve/extensions/code

`eve/extensions/code` is an eve extension for coding work. It contributes `apply_patch`, computer use, `gh`, `grep`, investigation and PR skills, a read-only worker subagent, sandbox tooling, and shared PR-watch primitives. Vercel credentials are brokered before each turn; GitHub credentials are scoped to one repository and leased for each `gh` tool invocation. Because eve workflow directives are application-only, consumers own their `prwatch` / `prwatch_delete` workflow tools.

It ships inside the `eve` package. This private `@eve/code` workspace package is its source of truth: eve's build copies `extension/` into `packages/eve/src/extensions/code/extension` and publishes it with these entry points:

- `eve/extensions/code`: the extension
- `eve/extensions/code/sandbox`: sandbox bootstrap and credential helpers
- `eve/extensions/code/tools`: `apply_patch`, `computer_use`, `gh`, and `grep`
- `eve/extensions/code/prwatch`: PR-watch primitives for consumer-owned workflow tools

## Mount

```ts
// agent/extensions/code.ts
import code from "eve/extensions/code";

export default code({
  // Optional; omit to mount without Connect-backed Vercel authentication.
  vercel: { connector: "vercel/acme-bot" },
});
```

Both connectors are optional; `code({})` mounts without either. The Vercel connector requests an app-subject token. Firewall delivery is the default and keeps tokens outside sandbox processes; without a consumer `broker`, it requires a sandbox provider that exposes `setNetworkPolicy()` and fails otherwise. Use `delivery: "command"` on the Vercel connector for providers without mutable network policy. A top-level `broker(sandbox, rules)` callback lets the consumer merge Vercel credential rules into its own network policy.

To enable the authenticated `gh` tool, configure `github` with `connector`, `org`, and a required `broker(sandbox, rules)` callback. The tool requests a token for exactly one repository in that organization. The callback installs the supplied GitHub header-transform rules for the command, then receives `null` to remove the lease. It must preserve the consumer's other network rules. GitHub authentication has no command-delivery option on this tool; sandbox processes receive a placeholder token, not the real credential.

The read-only worker subagent defaults to `openai/gpt-5.6-terra-fast` with `xhigh` reasoning. Set `worker: { model, reasoning, openaiReasoningEffort? }` to choose another model; `openaiReasoningEffort` is passed to OpenAI models as `reasoningEffort`.

## Sandbox bootstrap

Install CLI tooling and computer-use assets in the environment's `prepare` callback, then start the desktop and driver after `open()` in `defineSandbox()`. Computer use requires an apt-based Linux image with root or passwordless sudo; it cannot run on the `just-bash` provider.

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import {
  installCodeTooling,
  installComputerUse,
  startComputerUse,
} from "eve/extensions/code/sandbox";

export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await installCodeTooling(sandbox, { vercel: true });
    await installComputerUse(sandbox);
  },
});

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  await startComputerUse(sandbox);
  return sandbox;
});
```

eve derives the prepared environment generation from the sandbox file and environment options, not from imported helpers, so upgrading eve alone does not rebuild an existing prepared artifact.

Mounting the extension exposes `computer_use` but does not install or start its driver. The prepared artifact captures files, not running processes; the `defineSandbox()` selector starts the driver once for each new durable sandbox. If the driver exits or the provider resumes only filesystem state, call `startComputerUse` again before using the tool; resuming a sandbox does not rerun the selector. Stop recordings with `record_stop` to finalize the MP4 at the returned sandbox path. A five-minute watchdog also finalizes forgotten recordings, and the driver attempts finalization on `SIGINT` or `SIGTERM`; abrupt VM termination cannot guarantee a finalized MP4.

Preparation ensures `gh`, installs wrappers for `gh`, `vc`, and `gh-signed-commit`, and installs TypeScript diagnostics. For repositories requiring verified signatures, stage the intended changes and use `gh-signed-commit`.

## Non-Connect escape hatch

Consumers with a PAT, benchmark token, or another credential provider can omit the corresponding connector and call `authenticateGitHub` or `authenticateVercel` from `eve/extensions/code/sandbox` in their own sandbox lifecycle. These helpers support firewall, command-delivery, and broker options for consumer-owned commands; they do not configure the extension's `gh` tool.

## Develop in this workspace

Rebuild eve after editing `extension/`; the local agent under `agent/` mounts the built `eve/extensions/code`:

```sh
pnpm --filter eve build
pnpm --filter @eve/code typecheck
pnpm --filter @eve/code test
pnpm --filter @eve/code test:scenario
pnpm exec oxlint packages/eve-code
pnpm exec oxfmt --check packages/eve-code
```

Tests live under `test/`, outside the extension distribution. Unit and integration tests run through the workspace's matching test tasks. The package integration task depends only on eve's build. The root integration command runs the framework suite before the other packages because that suite rebuilds the runtime files they import. Scenario tests exercise temporary files, local Git repositories, and subprocesses; they need Node.js 24 or newer, Git, and Bash, but no model or service credentials.

The `typescript-compiler` development alias supplies the JavaScript compiler API used by the diagnostics worker test. The workspace's TypeScript 7 CLI remains the package typechecker. `prepack` builds the extension; installation does not run the extension CLI before the local framework has been built.

## Benchmarks

eve-code is benchmarked with [eve-bench](https://github.com/vercel-labs/eve-bench#readme) on the SWE-lean dataset. eve-bench owns datasets, execution, comparisons, and reports; this package keeps no benchmark runner of its own.

### In CI

The `eve-code > Benchmark harness` workflow runs whenever `packages/eve-code/**` changes. It benchmarks the PR head's eve-code, opencode, and pi together, using the model in the `EVE_CODE_BENCH_MODEL` repository variable. Every trial runs in its own Vercel Sandbox, and all of them start at once, so a run takes about as long as its slowest trial. Each harness is compared with its own latest result from `main`. The report covers resolved tasks, latency, and token usage. It goes to the job summary and a PR comment.

Comment `/benchmark` to re-run the default harnesses, or `/benchmark <harness>[,<harness>...]` to choose, for example `/benchmark codex,eve-code`. You need write access to the repository. Every push to `main` that touches eve-code publishes fresh results to the eve-bench result store, which is where later PRs get their baselines.

### Locally

With [eve-bench](https://github.com/vercel-labs/eve-bench#readme) linked (`npm link` in its checkout), commit and push this checkout, then run:

```sh
eve-bench -a eve-code --agent-dir packages/eve-code --model google/gemini-3.8-flash \
  --scope <vercel-team> --execution vercel-sandbox
```

Pass several harnesses to compare them in one run, for example `-a eve-code,opencode,pi`. Use `--task <name>` to run a single task. Local runs never publish to the result store.

### Investigating a failed trial

Trial sandboxes are deleted as soon as each trial finishes. Before deletion, eve-bench pulls each trial's logs and traces out of the sandbox and uploads them with the workflow artifact. To read them, point eve-bench at the CI run:

```sh
eve-bench trials logs https://github.com/vercel/eve/actions/runs/<id>
eve-bench trials logs https://github.com/vercel/eve/actions/runs/<id> --harness eve-code --task <task>
```

The report's Diagnostics section prints this command with the run URL filled in. The download uses the GitHub CLI and needs read access to this repository. The raw files (`agent.log`, `events.ndjson`, `observability.ndjson`, `verifier.log`) are cached under `~/.cache/eve-bench/runs/`.
