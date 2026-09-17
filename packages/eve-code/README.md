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

## Benchmarks

Use [eve-bench](https://github.com/vercel-labs/eve-bench#readme) directly. Its native `eve-code` harness accepts an installed source app through `--agent`; `apps/fixtures/eve-code-bench` supplies this workspace's eve and eve-code dependencies after the build above.

Dataset selection, execution, comparisons, and report generation belong to eve-bench. This package does not maintain a separate benchmark runner or reporting layer.

### Latest SWE-lean comparison

CI runs the full eight-task SWE-lean suite against the original eve-code baseline (`ca27ee898`), this PR's eve-code, Codex, and OpenCode. The latter two support the suite's MCP tasks. The native eve-bench action publishes the same table to the CI summary, PR comment, and the block below. Only a completed comparison updates this block; its source revision identifies the code tested. The rest of this README is left unchanged.

<!-- eve-code-benchmark:start -->
swe-lean@v2 · openai/gpt-5.6-terra · 8 tasks × 1 attempt(s) · 11304338b35c vs ca27ee898e28

| Harness | Passed | Score | Δbaseline | Time | Cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 7/8 | 87.5% | — | 954.3s | $0.80 |
| candidate | 6/8 | 75.0% | -12.5 pp | 400.1s | $0.60 |
| codex | 7/8 | 87.5% | +0.0 pp | 687.5s | unreported |
| opencode | 8/8 | 100.0% | +12.5 pp | 1456.4s | $1.12 |

[CI run](<https://github.com/vercel/eve/actions/runs/35264574875>)
<!-- eve-code-benchmark:end -->
