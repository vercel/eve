# Stagehand extension template

This package demonstrates an eve extension that imports the published Stagehand v4 SDK directly.
It contributes native `run`, `snapshot`, and `screenshot` tools without an MCP bridge or a copied
Playwright compatibility layer.

The extension declares `@browserbasehq/stagehand` and `@browserbasehq/sdk` in
`eve.extension.externalDependencies`. Stagehand loads browser-extension assets relative to its
installed package, and the Browserbase SDK provides a bounded release fallback if the browser
transport fails during initialization or cleanup. eve preserves both dependencies when it builds a
consuming agent.

The `run` callback receives Stagehand v4's `Page` and `BrowserContext` objects, not complete
Playwright objects. The bundled agent instructions enumerate the supported methods and warn models
not to guess Playwright-only helpers. Snapshot IDs are currently descriptive rather than actionable
selectors because this template does not retain Stagehand's snapshot lookup maps between tools.

## Use in an eve project

This is a private source template rather than a published package. Its source manifest intentionally
uses the eve monorepo's `workspace:` and `catalog:` dependency ranges. Consume it as a workspace
package, or pack it before installing it elsewhere so pnpm materializes concrete dependency
versions.

For an agent package named `my-agent` in the same pnpm workspace, add the template as a workspace
dependency:

```bash
pnpm --filter my-agent add "@eve-template/stagehand-extension@workspace:*"
```

To try it from a separate eve project, create a local package artifact from this repository and add
that artifact to the agent project:

```bash
mkdir -p /tmp/eve-stagehand-extension
pnpm --filter @eve-template/stagehand-extension build
pnpm --filter @eve-template/stagehand-extension pack \
  --pack-destination /tmp/eve-stagehand-extension

cd /path/to/eve-agent
pnpm add /tmp/eve-stagehand-extension/eve-template-stagehand-extension-0.0.0.tgz
```

Mount it by creating `agent/extensions/browser.ts` in the consuming project:

```ts
export { default } from "@eve-template/stagehand-extension";
```

## Build and test

```bash
pnpm --filter @eve-template/stagehand-extension build
pnpm --filter @eve-template/stagehand-extension typecheck
pnpm --filter @eve-template/stagehand-extension test:unit
```

## Browser configuration

Set `BROWSERBASE_API_KEY` and optionally `BROWSERBASE_PROJECT_ID` to use Browserbase. Without an API
key, the extension launches a headed local browser. Set `STAGEHAND_BROWSER` to `local` or
`browserbase` to choose explicitly. `BROWSERBASE_API_URL` can override the Browserbase API endpoint
for both launch and release.

The three tools share one browser for the life of the eve process. Browserbase sessions do not use
keep-alive, and `run` code can call `close()` to make the host close both Stagehand and the browser.
The next tool call starts a fresh browser. Tool operations, health probes, and cleanup are bounded;
a hung browser call is detached and cannot permanently block the serialized operation queue. If
browser cleanup fails, the extension requests release through the Browserbase SDK and retries a
failed release before launching another browser. Model-visible cleanup errors use stable messages
without exposing SDK, transport, or session details.

## Code execution boundary

`run` compiles model-authored JavaScript in the Node.js host before sending the serializable callback
to Stagehand. The callback executes in Stagehand's browser extension, where it can use `page`,
`context`, `act`, `observe`, and `extract`. Calling `close()` sends a cleanup request back to the host.

Browserbase provides the recommended isolation boundary. The callback does not execute in eve's Node
process, but it is still powerful browser-side code and should not be treated as a sandbox for
hostile input.
