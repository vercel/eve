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

Install the CLI tooling in the consumer sandbox during `bootstrap`:

```ts
import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";
import { CODE_TOOLING_REVALIDATION_KEY, installCodeTooling } from "eve-code/sandbox";

export default defineSandbox({
  backend: vercel(),
  revalidationKey: () => CODE_TOOLING_REVALIDATION_KEY,
  async bootstrap({ use }) {
    await installCodeTooling(await use(), { vercel: true });
  },
});
```

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

Tests live under `test/`, outside the extension distribution. Unit and integration tests run through the workspace's matching test tasks. The integration task waits for eve's integration task because that task rebuilds the runtime files these tests import. Scenario tests exercise temporary files, local Git repositories, and subprocesses; they need Node.js 24 or newer, Git, and Bash, but no model or service credentials.

The `typescript-compiler` development alias supplies the JavaScript compiler API used by the diagnostics worker test. The workspace's TypeScript 7 CLI remains the package typechecker. `prepack` builds the extension; installation does not run the extension CLI before the local framework has been built.
