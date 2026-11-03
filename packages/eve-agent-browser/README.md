# @eve/agent-browser

An [eve](https://eve.dev) extension that gives your agent 42 browser automation tools backed by [agent-browser](https://agent-browser.dev), running inside the agent's sandbox. Tools cover navigation, accessibility snapshots with element refs, form interaction, screenshots, JavaScript evaluation, tabs, and network and console inspection.

This package ports [`@agent-browser/eve`](https://github.com/vercel-labs/agent-browser/tree/main/packages/%40agent-browser/eve) into the eve workspace. It targets agent-browser 0.41.1 and requires eve 1.0.0-rc.1 or later.

## Install and mount

```bash
pnpm add @eve/agent-browser
```

Create a mount file under `agent/extensions/`. Its filename supplies the tool namespace:

```ts
// agent/extensions/browser.ts
import browser from "@eve/agent-browser";

export default browser({});
```

The agent gets `browser__open`, `browser__snapshot`, `browser__click`, and the other tools, plus instructions for the snapshot, act, and verify workflow.

Configure an [agent sandbox](https://eve.dev/docs/sandbox) with real process execution, such as Vercel Sandbox or Docker. The just-bash provider cannot run Chromium. On first use in a fresh sandbox, the extension installs agent-browser, Chromium, and its system libraries. Installing system libraries requires apt or dnf and sudo.

## Prepare a sandbox template

For production, install the browser in the environment's `prepare` callback so new sessions start from a prepared template:

```ts
// agent/sandbox.ts
import { installAgentBrowser } from "@eve/agent-browser/sandbox";
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await installAgentBrowser(sandbox);
  },
});

export default defineSandbox(() => environment.open());
```

The sandbox entry point also exports `runAgentBrowser` for calling the CLI from an authored eve tool, `buildAgentBrowserCommand` for constructing commands, and `agentBrowserRevalidationKey` for custom template caches. Install and run helpers accept an `abortSignal` option and forward it as the sandbox command's `signal`.

## Configuration

All fields are optional:

```ts
export default browser({
  // Access and output boundaries
  allowedDomains: ["example.com", "*.example.com"],
  caCert: "/etc/ssl/certs/proxy-ca.pem",
  clearCaCert: false,
  useSystemCa: true, // OS trust store for the CLI's own HTTPS requests
  contentBoundaries: true,
  maxOutputChars: 50_000,

  // Screenshots
  inlineScreenshots: true, // data URLs for channels/UIs, hidden from model output

  // Installation
  autoInstall: true,
  installSpec: undefined, // defaults to agent-browser@0.41.1; must match its minor
  installBrowser: true,
  installSystemDependencies: true,

  // Runtime
  session: undefined, // defaults to eve-default inside each sandbox
  sessionPrefix: "eve",
  binary: "agent-browser",
  proxy: undefined,
});
```

With `contentBoundaries: true`, tool results retain the CLI's `_boundary` metadata. Model output is wrapped in page-content markers after screenshot filtering. Primitive or array results use a `{ data, _boundary }` envelope. Calls reject missing or invalid boundary metadata instead of returning unmarked content.

`caCert` and `clearCaCert: true` cannot be combined. The domain allowlist applies to navigation and subresources. Use the sandbox's network policy as an additional boundary, and treat browser state, downloads, and screenshots as sensitive data.

By default, each sandbox uses the `eve-default` browser session. Set `session` when multiple mounts need independent browser sessions inside one sandbox. `sessionPrefix` changes the prefix of the default session name.

Inline screenshots are capped at 4 MiB per image. The tool result includes a data URL for the UI, but model output excludes the image and, after successful inlining, the sandbox path. If inlining fails or is disabled, the path stays in model output.

## Tools

The 28 tools in the CLI's `core` MCP profile are listed to the model every turn:

`back`, `check`, `click`, `close`, `eval`, `fill`, `forward`, `get_text`, `get_title`, `get_url`, `open`, `press`, `read`, `reload`, `screenshot`, `scroll`, `select`, `snapshot`, `tab_close`, `tab_list`, `tab_new`, `tab_switch`, `type`, `uncheck`, `wait_for_load`, `wait_for_selector`, `wait_for_text`, `wait_ms`.

The other 14 are deferred. The model discovers them with `eve__search`:

`console`, `dblclick`, `drag`, `errors`, `find`, `get_attr`, `get_box`, `get_count`, `get_html`, `get_styles`, `get_value`, `hover`, `network_requests`, `upload`.

Names, descriptions, and input schemas come from the matching CLI's MCP catalog. The extension hides app-owned arguments such as session selection, domain restrictions, CA settings, restoration, and raw CLI flags from the model. `close` cannot close other sessions.

Cookie, storage, and saved-auth-state commands aren't exposed because they can reveal credentials to the model. Add scoped tools with your application's guardrails if you need those capabilities.

## Override tools

Use a directory mount to gate or replace individual tools:

```ts
// agent/extensions/browser/extension.ts
import browser from "@eve/agent-browser";

export default browser({});
```

```ts
// agent/extensions/browser/tools/eval.ts
import { eval as evaluate } from "@eve/agent-browser/tools";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";

export default defineTool({ ...evaluate, approval: always() });
```

To remove a tool, export `disableTool()` from its matching file:

```ts
// agent/extensions/browser/tools/upload.ts
import { disableTool } from "eve/tools";

export default disableTool();
```

## Execution and version matching

Each tool runs one `agent-browser mcp call` process in the sandbox returned by `ctx.getSandbox()`. Browser state lives in the session daemon inside that sandbox. Calls pass the tool context's cancellation signal to sandbox commands and have a 180-second response deadline for sandbox acquisition, installation, version probes, and command execution. A deadline reports failure; it does not confirm that the underlying process stopped. Inspect the live page before repeating a state-changing action after a timeout.

With auto-install enabled, the extension probes the CLI on every call. A missing or different-minor default install is replaced. An installed custom binary or custom install spec with a mismatched version produces an install hint instead. Responses carrying another minor version are rejected even when auto-install is disabled. Snapshot retries once after a reported CDP error.

## Develop

Run from the eve repository root:

```bash
pnpm install
pnpm exec turbo run build --filter=@eve/agent-browser
pnpm --filter @eve/agent-browser test
pnpm --filter @eve/agent-browser typecheck
```

Tests exercise the built extension against in-memory sandbox doubles. They don't launch Chromium or verify a live sandbox provider.

The MCP catalog and sandbox command helpers in `extension/lib/mcp-tools.json`, `shared.ts`, and `version.ts` are copied from `vercel-labs/agent-browser` at commit `2d1271baefa026161de333a0da55c0f9e118a07f` (agent-browser 0.41.1), under Apache-2.0. The published sandbox helpers use these local copies, so consumers don't need `@agent-browser/sandbox`.

The [agent-browser bump workflow](../../.github/workflows/agent-browser-bump.yml) checks npm daily and opens a PR that refreshes those files together when a newer agent-browser is released. To bump by hand, run `node .github/scripts/agent-browser-bump.mjs sync [version]` from the repository root. Either way, review the exposed tools against the catalog changes listed in the PR and run the package tests.

## License

Apache-2.0
