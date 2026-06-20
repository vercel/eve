# eve

## 0.11.10

### Patch Changes

- c707ca3: Keep `eve init` and local `eve dev` progress on one terminal row. Init now includes elapsed completion times and preserves useful package-manager diagnostics on failure. With `EVE_LOG_LEVEL=debug`, both commands use plain phase logs instead of animation.
- 2197c14: Dynamic skill resolvers that return a map now name every entry `<slug>__<key>` even when the map holds a single entry, matching dynamic tools and the documented contract. Previously a one-entry map was advertised and materialized under the bare resolver slug, so `load_skill` failed to find it and adding a second skill silently renamed the first. `load_skill` failures now also list the available skill names so the model can correct a wrong id.

  Adds a `t.loadedSkill(skill, opts?)` eval assertion — sugar for `t.calledTool("load_skill", { input: { skill }, ... })`.

- d22fd04: In the dev TUI, Ctrl+C now clears a non-empty chat or freeform `ask_question` prompt instead of quitting. On an empty prompt it still quits, and during a running turn it still interrupts.
- d22fd04: The dev TUI prompt now takes multi-line input in both chat and freeform `ask_question` fields. Pasting multi-line text inserts it intact instead of submitting at the first line, `Shift+Enter` inserts a newline, a tall prompt scrolls within the terminal height, and editing moves by whole graphemes so wide and emoji characters aren't split.

## 0.11.9

### Patch Changes

- 4bfbaa0: Add root agent `experimental.workflow.world` configuration for selecting an installed Workflow world package. Eve now loads and registers the configured world at runtime and documents how self-hosted deployments can provide a custom Workflow world.

## 0.11.8

### Patch Changes

- 4622d94: Point the npm README, runtime landing page, and setup guidance at the canonical eve documentation domain.
- bfc7191: Use the official TypeScript 7 `tsc` compiler for eve builds, base generated projects, and fixture typechecks. Next.js projects and generated Web Chat apps pin `typescript@6.0.3`, which still provides the JavaScript compiler API Next.js requires.

## 0.11.7

### Patch Changes

- 11a9a3e: Report image-pull and VM-boot progress during microsandbox creation, and include phase and provider-specific recovery guidance when prewarm fails.
- 7b8df64: Serialize optional sandbox engine auto-installs and reload newly installed engines through their package entrypoint file instead of retrying the cached bare specifier. This prevents first-run `eve dev` sessions from racing microsandbox installation or surfacing Node's stale same-process module-not-found result after Bun installs `microsandbox`.

  `eve init` also supports `EVE_INIT_PACKAGE_SPEC` so local tarball/source validation can make the generated project install the same eve build under test instead of resolving the published semver range from the registry.

- 159d4af: Slack reasoning typing indicators now update progressively when the cumulative status grows by at least four characters, preventing opening fragments from remaining stale without issuing one Slack request per token.

## 0.11.6

### Patch Changes

- 23cb00f: Slack channels now refresh assistant thread typing status during streamed reasoning, using a truncated reasoning snippet so long reasoning steps keep visible progress before tool calls or final replies.

## 0.11.5

### Patch Changes

- 4761011: Avoid creating workflow park hooks with an empty continuation token. Sessions that start without a token now wait until the first turn anchors one before registering the park hook.
- 93ff280: The `eve dev` header now shows the beta-terms link inline (`eve is currently in preview: <url>`), clickable via the terminal's own URL matcher. The verbose preview notice is dropped from the boot banner and from `eve init` output.
- 432503d: Clarify the duplicate `eve dev` process error with a copyable package-manager command for connecting to the existing local server instead of stopping it.
- c0c5cbf: Upgrades the workflow dependency to 5.0.0-beta.19
- 602e9e0: Detect parent workspace package managers when running `eve init <name>` so fresh agents created inside monorepos install with the workspace manager instead of always following the launcher.
- 0bd7aca: Warn when a Vercel build skips sandbox template prewarming because `VERCEL_DEPLOYMENT_ID` is missing, and direct users away from deploying that output with `vercel deploy --prebuilt`.

## 0.11.4

### Patch Changes

- e5b777b: Resolve AI Gateway OIDC readiness through Vercel's token resolver so `eve dev` recognizes projects linked by the Vercel CLI without requiring an environment pull or showing a missing-credentials setup issue.

## 0.11.3

### Patch Changes

- 1e2e8ef: Standardize the product name as `eve` across documentation, CLI output, diagnostics, generated text, and runtime messages.
- ea35d0e: Changing a model or configuring its provider in `/model` now returns to the prompt and prints the result there. Cancelling or choosing an external provider still returns to the menu.
- ea35d0e: The dev TUI now shows `/vc` or `/login` before `/model` when Vercel authentication is blocking model setup.
- 29e27b8: Run `vercel link` non-interactively when connecting a project via the dev TUI `/model` menu (and `eve link`). The link is already fully specified by the team and project picked in the TUI, so the CLI no longer inherits a TTY and can no longer surface its interactive prompts (such as the agent/MCP setup question), which previously corrupted the TUI.

## 0.11.2

### Patch Changes

- dbac239: Fix dynamic connection tools so approval gates from OpenAPI and other connection-backed tools are preserved when the tools are exposed to the model. Calls to connections with `approval: always()` now correctly park for HITL approval before execution.

## 0.11.1

### Patch Changes

- e7cdefd: Handle missing sandbox template and session state more gracefully across Vercel, Microsandbox, and Docker backends. eve now treats stale Vercel template references, missing Microsandbox session/template snapshots, and Docker template image races as recoverable provisioning misses so the runtime can rebuild or create a fresh sandbox automatically.

## 0.11.0

### Minor Changes

- 31fb09f: Remove the `withEve` Vercel output opt-out option. Next.js projects now skip generated Vercel Build Output writes when no linked Vercel project or existing output context is detected.

### Patch Changes

- ff80e38: The `eve eval --verbose` help text now refers to `t.log` (the actual eval context logging API) instead of the outdated `ctx.log`.
- f6c5932: Emit a `rejected` `action.result` stream event when a tool call is denied at a HITL approval gate. Denied calls previously left no trace in the session stream (the denial lived only in model history), so consumers like observability never saw the tool call resolve. The `action.result` status union now includes `rejected`, and the message stream version is bumped to `16`.

## 0.10.0

### Minor Changes

- c2ac540: Initial public release of the eve framework
