# eve-code

`eve-code` is an eve extension for coding work. It contributes `apply_patch`, computer use, `gh`, `grep`, investigation and PR skills, a read-only worker subagent, sandbox tooling, and shared PR-watch primitives. Vercel credentials are brokered before each turn; GitHub credentials are scoped to one repository and leased for each `gh` tool invocation. Because eve workflow directives are application-only, consumers own their `prwatch` / `prwatch_delete` workflow tools.

This private package is staged for extraction from `internal-agents/packages/eve-code` at commit `67e53bdc4`. The original package and its e0 and v consumers remain in internal-agents until publication and consumer migration are handled separately.

## Mount

```ts
// agent/extensions/code.ts
import code from "eve-code";

export default code({
  // Optional; omit to mount without Connect-backed Vercel authentication.
  vercel: { connector: "vercel/acme-bot" },
});
```

Both connectors are optional; `code({})` mounts without either. The Vercel connector requests an app-subject token. Use `delivery: "command"` on the Vercel connector for local backends without `setNetworkPolicy`. Firewall delivery is the default and keeps tokens outside sandbox processes. A top-level `broker(sandbox, rules)` callback lets the consumer merge Vercel credential rules into its own network policy.

To enable the authenticated `gh` tool, configure `github` with `connector`, `org`, and a required `broker(sandbox, rules)` callback. The tool requests a token for exactly one repository in that organization. The callback installs the supplied GitHub header-transform rules for the command, then receives `null` to remove the lease. It must preserve the consumer's other network rules. GitHub authentication has no command-delivery option on this tool; sandbox processes receive a placeholder token, not the real credential.

## Sandbox bootstrap

Install CLI tooling and computer-use assets during `bootstrap`, then start the desktop and driver in `onSession`. Computer use requires an apt-based Linux image with root or passwordless sudo; it cannot run on the `just-bash` backend. Include both revalidation keys so cached templates rebuild when either helper changes:

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";
import {
  CODE_TOOLING_REVALIDATION_KEY,
  COMPUTER_USE_REVALIDATION_KEY,
  installCodeTooling,
  installComputerUse,
  startComputerUse,
} from "eve-code/sandbox";

export default defineSandbox({
  backend: vercel(),
  revalidationKey: () => `${CODE_TOOLING_REVALIDATION_KEY}:${COMPUTER_USE_REVALIDATION_KEY}`,
  async bootstrap({ use }) {
    const sandbox = await use();
    await installCodeTooling(sandbox, { vercel: true });
    await installComputerUse(sandbox);
  },
  async onSession({ use }) {
    await startComputerUse(await use());
  },
});
```

Mounting the extension exposes `computer_use` but does not install or start its driver. Bootstrap caches files, not running processes; `onSession` starts the driver for each new session. If the driver exits or the backend restores only filesystem state, call `startComputerUse` again before using the tool; reattachment does not necessarily rerun `onSession`. Stop recordings with `record_stop` to finalize the MP4 at the returned sandbox path. A five-minute watchdog also finalizes forgotten recordings, and the driver attempts finalization on `SIGINT` or `SIGTERM`; abrupt VM termination cannot guarantee a finalized MP4.

Bootstrap ensures `gh`, installs wrappers for `gh`, `vc`, and `gh-signed-commit`, and installs TypeScript diagnostics. For repositories requiring verified signatures, stage the intended changes and use `gh-signed-commit`.

## Non-Connect escape hatch

Consumers with a PAT, benchmark token, or another credential provider can omit the corresponding connector and call `authenticateGitHub` or `authenticateVercel` from `eve-code/sandbox` in their own sandbox lifecycle. These helpers support firewall, command-delivery, and broker options for consumer-owned commands; they do not configure the extension's `gh` tool.

## Develop in this workspace

Build the local framework and extension in dependency order:

```sh
pnpm exec turbo run build --filter=eve-code
pnpm --filter eve-code typecheck
pnpm --filter eve-code test
pnpm --filter eve-code test:scenario
pnpm exec oxlint packages/eve-code
pnpm exec oxfmt --check packages/eve-code
```

Tests live under `test/`, outside the extension distribution. Unit and integration tests run through the workspace's matching test tasks. The package integration task depends only on eve's build. The root integration command runs the framework suite before the other packages because that suite rebuilds the runtime files they import. Scenario tests exercise temporary files, local Git repositories, and subprocesses; they need Node.js 24 or newer, Git, and Bash, but no model or service credentials.

The `typescript-compiler` development alias supplies the JavaScript compiler API used by the diagnostics worker test. The workspace's TypeScript 7 CLI remains the package typechecker. `prepack` builds the extension; installation does not run the extension CLI before the local framework has been built.

## PR benchmark

Add the `eve-code-benchmark` label to a same-repository PR to run the [full comparison workflow](../../.github/workflows/eve-code-benchmark.yml), or dispatch it manually. It runs all 89 pinned Terminal-Bench 2.0 tasks once for each of six arms: the original eve-code baseline (`ca27ee898`), the PR's eve-code, Codex, Claude Code, OpenCode, and Hermes. PR updates rerun the comparison while the label remains attached; remove the label to stop automatic full runs.

Both eve-code arms use the same current framework and fixture. Only the baseline's extension source is restored from the original revision. The runner, dataset, baseline, and competitor versions are pinned in `scripts/eve-code-benchmark-config.json`; executed source hashes and harness versions are checked before accepting results. Eight shards per arm run one task at a time, with at most eight CI workers in parallel. This is 534 task attempts and can take hours.

The CI summary and one updated PR comment contain the same comparison table: passed tasks, score, percentage-point difference from baseline, errors, average time, and cost. Missing or invalid results are not scored, and unreported cost is not treated as zero. Per-shard results and task diagnostics are uploaded even on failure. An older run cannot replace the current PR head's comment.

Configure `AI_GATEWAY_API_KEY` and `EVE_BENCH_SSH_KEY` as repository secrets. The latter holds a read-only deploy key for the private `vercel-labs/eve-bench` runner and is used only for checkout, without persisting credentials. All arms use the same root model, defaulting to `openai/gpt-5.6-terra`; override it with `EVE_CODE_BENCH_MODEL`. The eve-code worker retains its configured model. Fork PRs are skipped. This terminal suite does not test Connect authentication, desktop provisioning, or consumer-owned PR-watch workflows.
