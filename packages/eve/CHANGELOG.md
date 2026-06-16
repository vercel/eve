# eve

## 0.9.7

### Patch Changes

- aa27e10: Keep `eve dev` open when Ctrl+C interrupts a running agent response without ending the session. Eve stops rendering further output and drains the turn to its natural boundary before returning to the prompt.

## 0.9.6

### Patch Changes

- 08c9bb5: OpenAPI connections now accept Swagger 2.0 documents, including `schemes`/`host`/`basePath`, top-level parameter schemas, body parameters, and `securityDefinitions`. This lets agents connect directly to APIs such as Transport for London's public Swagger spec.

## 0.9.5

### Patch Changes

- 7c45498: Allow `eve init` with no target, `eve init .`, and `eve init ./` to scaffold a full agent in the current empty directory. Existing package directories still use the add-agent flow.

## 0.9.4

### Patch Changes

- 285386b: Limit sandbox bootstrap failure stdout and stderr in thrown errors so large install logs cannot inflate workflow memory usage.
- 3e9b8d9: Allow `write_file` to overwrite an existing empty file after it has been successfully read with `read_file`.
- aa1f593: Vendor semver for the Eve CLI bootstrap so production installs no longer need semver as a runtime dependency.

## 0.9.3

### Patch Changes

- 49a7e1f: Update `ai` and `@ai-sdk/*` packages to beta
- dc647b3: Updated the `@workflow/*` dependencies to their latest beta versions: `@workflow/core` 5.0.0-beta.17, `@workflow/errors` 5.0.0-beta.8, `@workflow/world` 5.0.0-beta.10, and `@workflow/world-local` 5.0.0-beta.18.

## 0.9.2

### Patch Changes

- 7f3fbc5: The dev TUI gains a `/login` command that runs `vercel login` as a browser flow the panel waits on (with a Cancel action), mirroring the Slack Connect wait. Flows that need a Vercel account now route you to it: `/model`, `/channels` (including its Slack-provisioning and deploy continuations), and `/deploy` say "run /login" when you're logged out instead of dumping a raw error, the Slack channel row distinguishes logged-out (`/login`) from unlinked (`/model`) and is blocked even when the directory is already linked, and a "not logged in · /login" hint appears at startup. A scoped lookup denied with a 403 (for example a team that enforces SSO/SAML the session hasn't completed) is routed to `/login` to re-authenticate. A missing Vercel CLI is detected distinctly (never mislabeled "not logged in") and gets its own `/vc` command that installs it, so every diagnostic — not linked, not logged in, CLI missing — has a matching fix command and a startup hint. The startup hint is a live element that clears the moment its issue is resolved (run `/login` and the "not logged in" line disappears) instead of lingering stale in the transcript. The login probe is bounded and runs without the coding-agent environment markers (so a read-only check can't trigger a login flow), and a transient/network failure is reported as "couldn't reach Vercel" rather than sending you to `/login`.

  The AI Gateway "Connect via a project" row now runs that prerequisite check before selection and stays disabled until the Vercel CLI is installed, the session is authenticated, and Vercel is reachable. "Use my own key" remains available.

- 7f3fbc5: `eve init` detects when an AI coding agent launched it. With no target, it asks the agent to collect the purpose, target, and Web Chat choice from the user; after scaffolding, it points the agent at the bundled docs, asks it to write the purpose into `agent/instructions.md`, and prints the interactive `eve dev` command for the user to run.
- 7f3fbc5: `eve dev` now advances to the next available local port when another process already owns port 3000, preventing the terminal UI from connecting to the wrong agent.
- 7f3fbc5: Slack channel setup now treats Vercel's completed browser verifier as the end of a new workspace setup and reads existing workspace state from the connector detail response, avoiding a second wait on the empty installations endpoint.
- 2a77e8d: Eve no longer declares `oxc-parser` as a direct runtime dependency. Model source edits now use the same Rolldown parser loaded from Nitro that workflow transforms already use.

## 0.9.1

### Patch Changes

- 79dcb7b: Update the AI SDK peer dependency range to accept `ai` versions starting at `7.0.0-beta.177`, and use that beta for workspace development installs.
- bd96d9c: Delay local dev rebuild errors in `eve dev` until the next user prompt unless all logs are enabled. A successful rebuild clears the delayed error so stale HMR failures are not shown after the agent builds cleanly.
- 9009664: `eve dev` now records its active process in `.eve/dev-process.pid` and refuses to start a second local server for the same agent while that process is still running. The duplicate-start message includes the command to stop the existing server.
- 9936fc8: Fail sandbox bootstrap immediately when a `sandbox.run` command exits with code 1, including the command plus full stdout and stderr in the error.
- 6d7a4e5: Scaffolded projects now select the lowest complete Node.js major supported by Eve's own `package.json` `engines.node` contract and pin that major (e.g. `24.x`). The CLI bootstrap validates the exact authored range and ships its runtime semver dependency, while `eve init` and Web Chat use the invoking Eve release's matching dependency version and engine contract.
- 6d7a4e5: Scaffolded agent projects now declare `@types/node` at the same major selected for `engines.node` and set `compilerOptions.types: ["node"]` in `tsconfig.json`. Agent code that touches `process` or Node built-ins now typechecks without exposing APIs from a newer Node major than the generated app declares.

## 0.9.0

### Minor Changes

- ccaa1ae: Move concrete sandbox backend factories out of `eve/sandbox` and into nested backend imports: `eve/sandbox/docker`, `eve/sandbox/just-bash`, `eve/sandbox/microsandbox`, and `eve/sandbox/vercel`. Agent sandbox definitions should import `defineSandbox` and `defaultBackend` from `eve/sandbox`, and concrete backend factories from the matching nested entrypoint.

## 0.8.6

### Patch Changes

- 2dbcc18: Use `ghcr.io/vercel/eve:latest` as the default image for Docker and microsandbox local sandbox backends.
- b469b8d: Route Vercel sandbox template and session lookups through Eve's resolved sandbox credentials when available. This avoids the Vercel Sandbox SDK's local team-scope inference path, which can fail prewarm when Vercel's teams API omits optional metadata fields.
- e7bbd0e: Vercel sandbox creation now uses the `@vercel/sandbox` SDK path again while still passing Eve's internal `__image` configuration through SDK create options.
- b14567e: Recover from expired Vercel sandbox template snapshots by invalidating the stale template and rebuilding it during the existing runtime prewarm retry path.

## 0.8.5

### Patch Changes

- 2c2474b: `eve dev` again rebuilds authored artifacts on every save, not just changes to `agent.ts`. Edits to instructions, tools, skills, channels, and other authored files are picked up immediately (debounced) instead of being deferred until the next REPL message.
- 5145fd1: Surface provider-managed tools such as `web_search` through normal tool call and result stream events so existing stream renderers can display provider-executed activity.

## 0.8.4

### Patch Changes

- ed7ee20: In the dev TUI, Ctrl+L now cycles the log filter (`none → all → stderr → sandbox`) and briefly shows the new mode as a `logs: <mode>` entry in the status line that clears after 5 seconds of no further cycling. Ctrl+R remains the redraw shortcut.
- ed7ee20: The dev TUI `/loglevel` command and `--logs` flag gain a `sandbox` mode and now treat sandbox lifecycle lines as a filterable source alongside stdout and stderr: `all` shows all three, `stderr` shows only stderr, `sandbox` shows only sandbox lines, and `none` hides everything. `eve dev` still starts in `stderr`, so sandbox lines stay hidden until you switch to `sandbox` or `all`.
- 1b1d55b: Queue most `eve dev` authored-source changes until the next user message while rebuilding root `agent.ts` changes immediately. Sandbox prewarm skips unchanged signatures, suppresses low-value cache/reuse progress in the dev REPL, and sandbox backends now keep framework setup minimal by only preparing `/workspace`, verifying Bash, and creating the microsandbox user where needed.
- ed7ee20: The dev TUI no longer shows the "Type to chat / for commands" hint on the empty prompt, and the status line's token-flow segment drops its leading glyph (now `↑ 394.4K ↓ 4.3K`). The CLI boot banner and `eve init` messages now spell the product as plain `eve` instead of the styled `𝐞𝐯𝐞` wordmark, and the dev TUI startup header drops its leading `▲` (now `eve <agent name>`).

## 0.8.3

### Patch Changes

- 2480caa: Prepare hosted Vercel sandboxes with Eve's baseline runtime setup before authored bootstrap code runs, matching the local Docker setup path more closely. The hosted and Docker baseline now includes Python 3 alongside Node 24, npm, Bash, ripgrep, and other setup tools.
- 1611f4a: Avoid probing unused sandbox backends during `eve dev` shutdown. Development cleanup now only stops Docker or microsandbox resources for backends that actually initialized during the current dev run.
- 1d1a234: `eve init` now pins `ai` via `overrides`/`resolutions` in the generated `package.json`. Without it, `npm` and `yarn` reject the prerelease `ai` against `@vercel/connect`'s `^6 || ^7` peer range and fail the first install with `ERESOLVE`.

## 0.8.2

### Patch Changes

- f453509: The dev TUI `/model` flow's "Connect via a project" option can now create a new Vercel project, not only link an existing one. A fresh agent with no project no longer dead-ends on an empty "Project to link" list. `eve link` stays existing-only.

## 0.8.1

### Patch Changes

- 0e6a518: Route `eve dev` startup sandbox prewarm logs into the TUI sandbox section instead of printing them above the interface. Fast prewarms are retained for the TUI startup replay, so the sandbox progress is still visible without corrupting the terminal frame.

## 0.8.0

### Minor Changes

- b460a24: Add explicit sandbox backends for Docker, microsandbox, just-bash, and Vercel, with `defaultSandbox()` choosing the best available backend for local dev.

  Docker and microsandbox now use Ubuntu 26.04 and show sandbox initialization progress directly in the dev TUI.

- d1caa14: Slack Connect provisioning now keeps fresh requests controllable with "Try again" and "Cancel", while stale project-owned connectors offer a safe "Stop waiting" path with manual recovery instructions. Retry starts a fresh request only after exact connector removal, connector reuse is scoped to the linked project, and `ProvisionSlackbotResult` now uses `state` as its sole lifecycle discriminant without redundant `created` or `attached` fields. After a deploy-and-chat, Eve now opens your browser straight to a direct message with the bot (the Slack Messages tab) instead of the app's about page; `ProvisionSlackbotResult.workspaceUrl` is renamed to `chatUrl` to reflect this.

### Patch Changes

- 06fa3c4: Picking a new Vercel project name no longer prints a duplicate warning when the name is taken. Only the line naming the project and team shows, without the redundant "Project name unavailable" headline above it.
- d1caa14: The dev TUI `/channels` menu now reads as a channel task list: Terminal UI and configured channels stay visible as checked, non-selectable items with an "Already installed" focus hint, available channels remain selectable, and the latest add outcome appears below the list. Channels that provision against Vercel (Slack) are disabled while the directory is unlinked with a yellow "Requires Vercel account, see /model" hint instead of walking inline link pickers.
- d1caa14: The dev TUI status-line pending-deploy marker now reads `/deploy pending` instead of `deploy pending`, naming the command that ships the pending channel changes.
- 467267d: `eve dev` now accepts `--input <text>` to pre-fill the first prompt without submitting it. `eve init` uses this to open new agents with `/model` ready to edit or send.
- 06fa3c4: Adding a channel while `eve dev` runs now works end to end. New projects ship `@vercel/connect` from `eve init`, so a later `eve channels add slack` never introduces a missing dependency; on existing projects, authored modules that import a not-yet-installed package fail at bundle time with an actionable message instead of poisoning Node's resolver cache (which previously kept the rebuild failing even after install until restart). Channel routes added mid-session mount in the dev worker instead of crashing it with an unresolved virtual module.
- dcd600e: Move bundled documentation from `node_modules/eve/dist/docs` to `node_modules/eve/docs`. Scaffolded agent instructions and package docs now point agents at the new package docs root, and pnpm setup now prefers the active pnpm executable over an older `PNPM_HOME` binary when both are present.
- d1caa14: `eve dev`'s setup commands (/deploy, /channels, /model) now keep a failed command's captured subprocess output in the transcript after the flow panel closes, so a `vercel deploy --prod` failure shows the actual deploy error instead of only the exit-code summary. The settled-output buffer also grew from 8 to 40 lines so a build error's tail survives.
- 06fa3c4: Dev TUI setup commands (/model, /channels, /deploy) can now be interrupted while they wait on setup work. Ctrl-C or Esc aborts the active subprocess and waits for the setup stack to unwind before returning to the prompt, so no abandoned command keeps mutating the project in the background.
- d1caa14: Typing a complete slash command in the dev TUI (e.g. `/model`) now collapses the suggestion dropdown into a dim argument hint trailing the prompt (`❯ /model [provider/model]`) instead of a one-row list above it. Partial or ambiguous drafts still open the list, which no longer windows commands out of view on a bare `/`.
- 06fa3c4: The `/model` and `eve link` flows are much quieter. The configure menu gains an explicit Done row, a taken project name warns inline with the "New project name" question (and disappears once a free name is submitted), the redundant "not linked yet", "Connected the agent…", "Model credentials ready…", and "reloads env files…" lines are gone, the provider outcome notice is a short "Connected to AI Gateway", and a source reload no longer repeats an unchanged agent banner in the dev TUI.
- d1caa14: `eve link` and the dev TUI's project-connection flow now go directly from team selection to the existing-project list, without repeating the create-or-link question used by onboarding.
- d1caa14: The dev TUI decides AI Gateway readiness from how the agent's model routes, not from whether a Vercel project is linked. The compiler records each model's routing (gateway or external provider) in the manifest, and `/eve/v1/info` exposes it. The status bar shows `AI Gateway (project)` when connected, a yellow `⚠ AI Gateway` when the gateway has no credential, or `External endpoint` for a direct provider, and it drops the token counter until a turn moves a token. The "provider required" setup prompt now appears only when the model routes through the gateway with no credential. In `/model`, changing the model is disabled when it's set via an SDK model call (Eve can't rewrite that source), and changing the provider is disabled for an external endpoint.
- d1caa14: The dev TUI `/model` menu now opens on the row that matters first — the provider row when no provider is configured — and lands the cursor on "Done" after any completed sub-flow. The apply line reads `Model changed to <model>. Live on your next prompt.` (model bolded), and the provider outcome reads `Project linked. Connected to AI Gateway via …`.
- d1caa14: The dev TUI `/model` panel header now reads "Configure the agent model", and the menu inside it drops its redundant second title.
- 06fa3c4: Setup-owned `pnpm install` now determines ancestor-workspace membership before installing. Claimed members keep native workspace resolution for `workspace:*` and `catalog:` dependencies, while unclaimed nested projects install standalone without first running the ancestor workspace or its lifecycle scripts.
- d1caa14: While an `eve dev` turn is running, live thinking and activity render above the persistent chat prompt instead of replacing it.
- d1caa14: The dev TUI now refreshes its cached Vercel project identity after provider setup, so re-linking updates the status line without restarting `eve dev`.
- d1caa14: After a Slack channel connects in the dev TUI `/channels` flow, a "See it live" prompt offers "Deploy and chat" — which deploys the agent and then surfaces the Slack workspace link so you can message the bot — or "Later", which returns to the channel list.
- d1caa14: Dev TUI setup panel fixes: clipped rows now close their color spans so an overflowing notice can no longer bleed its color into the question and input below; the taken-project-name warning is fully yellow with the names in the default foreground; and /model and /channels panels carry a constant title (Agent model, Agent channels) like /deploy.
- 06fa3c4: Slack channel files are only scaffolded after a fully successful Slack connection. Provisioning reuses an existing project connector on reruns, enforces one five-minute deadline for the browser install, and reports lookup failures separately from a still-pending installation.
- d1caa14: The dev TUI `/model` provider gate ("Which model provider…") and gateway connection gate ("How do you want to connect…") now render stacked — each option's hint on its own line beneath the label — matching the model menu's primary entry point.
- d1caa14: The `eve dev` setup panels now use one aligned state-glyph column across model, channel, team, and project selection, with aligned searchable-list metadata. Focusing the new-project row turns its name into an inline editor, so typing and editing keys rename it directly.
- d1caa14: Setup pickers now share one option-row renderer across the CLI prompts and the dev TUI, so every list looks the same: a single state glyph that changes on hover, hints tab-aligned to a shared column (and only to rows that actually carry a hint), and dimmed (no longer struck-through) disabled rows. A completed row under the cursor reads as inert — a dim pointer rather than a green check — and an editable row (the Vercel project name) is renamed by hovering it and typing or backspacing, with a blinking caret parked after the value.
- d1caa14: When you paste an `AI_GATEWAY_API_KEY` in the `/model` provider setup, Eve round-trips it against the AI Gateway before saving. It shows "Validating…", then "✓ Valid key" on success. A rejected key isn't saved; you return to the prompt to retry (or Esc to cancel). If the gateway can't be reached, Eve saves the key with a warning rather than block on a flaky network.
- d1caa14: The scaffolded `.vercelignore` now also excludes `.workflow-data` and `.env*`, so `vercel deploy` from an app directory neither uploads workflow state nor a bare `.env` file (Vercel only default-ignores `.env.local` variants), and dev artifacts can no longer push the upload past the platform's request-size limit.
- 7dfcefe: The dev TUI now wraps long agent question prompts (and connection-auth titles) to the terminal width. Previously a prompt wider than the terminal soft-wrapped underneath the live region's row accounting, leaking a duplicate copy of the question line into scrollback on every repaint.

## 0.7.4

### Patch Changes

- a751461: fix(eve): fix vulnerabilities flagged by deepsec

## 0.7.3

### Patch Changes

- 20aa34f: Remove the eval mock-model surface and the `requires` field. `eve eval` no
  longer accepts `--mock-models` or `--no-skips`, `defineEval` no longer accepts
  `requires`, and the `skipped` verdict, `EveEvalRequirement`, and
  `EveEvalRequirementError` exports are gone. Evals now always run against a live
  model target (local dev server or `--url`); `dispatchSchedule()` enforces dev
  routes directly from the target capability. The deterministic mock-model
  adapter remains internal to the test tiers (active only under `NODE_ENV=test`).

## 0.7.2

### Patch Changes

- 7504d7f: Sandbox template keys now derive their Eve version segment from the compile metadata bundled with the app instead of resolving the installed package version at runtime. Deployed runtimes previously could resolve a different version string than the build-time prewarm (when the bundled fallback version was unstamped), compute a different template key, and fail every sandbox turn with "Sandbox template … is not provisioned"; build and runtime now always agree on the key.
- 7504d7f: Vercel stable sandbox template scopes no longer depend on `VERCEL_TEAM_ID`. Vercel exposes `VERCEL_PROJECT_ID` at both build and runtime but has no team system variable at runtime, so a build that set `VERCEL_TEAM_ID` would prewarm a template the deployed function could never resolve — surfacing as `Sandbox template … is not provisioned`. Stable templates are now keyed on the project id alone, so build-time prewarm and the deployed runtime always agree.

## 0.7.1

### Patch Changes

- a4d23ba: Bump the Workflow packages to the latest betas (`@workflow/core@5.0.0-beta.15`, `@workflow/world@5.0.0-beta.9`, `@workflow/world-local@5.0.0-beta.16`).
- 1728183: Declare `oxc-parser` as a runtime dependency, pinned to an exact version. Installed releases crashed `eve dev` with a silent non-zero exit when `/model` ran, because the model flow's source editor imports `oxc-parser` but releases since 0.6.x only declared it as a devDependency. The exact pin means every `eve` release ships the native parser version it was tested against, instead of floating to the newest patch at install time.
- 3168daa: `pnpm create eve` is back: the create-eve package returns as a launcher whose only job is to run the bundled eve's `init`, forwarding every argument. The scaffolded project belongs to the package manager that invoked the create command — `npm create eve` produces an npm project, `pnpm create eve` a pnpm one, `yarn create eve` a yarn one.

## 0.7.0

### Minor Changes

- aa5cfdc: Connection and tool `auth` definitions accept an optional `displayName`, and authorization challenges carry it to channels — sign-in buttons now show e.g. "Sign in with Salesforce" instead of a title-cased file name. The value is presentation-only (scope, token cache keys, and callback URLs stay keyed by the path-derived name), a definition-level `displayName` wins over one the strategy stamps on the challenge, and channels keep title-casing the name when neither is set.
- 20f0fc8: The dev TUI's `/channels` is now an action list: pick an unregistered channel to run its add flow, return to the repainted list (added channels show locked), and leave with the Done row or Esc. Web Chat (the Next.js app) is now addable in projects that already have the scaffolded `agent/channels/eve.ts` session channel — the row locks only when the project actually depends on `next`, and the REPL channel shows as its own locked row.
- fe98d0b: Compaction is now owned by the framework instead of individual tools. The per-tool `onCompact` hook (and the `CompactionInput` / `CompactionHookResult` types) is removed: the framework automatically preserves its own tool state across compaction — it resets read-before-write tracking and re-injects the active todo list. `defineReadFileTool` no longer accepts an `onCompact` option, and the agent-info response drops the now-meaningless `hasCompactionHook` field.
- 20f0fc8: The dev TUI now discovers its slash commands: typing `/` opens a suggestion list above the prompt with each command's argument hint and description — `↑`/`↓` move the highlight, `Tab` completes, `Enter` runs, `Esc` dismisses — and a new `/help` command prints the full table. Unknown `/text` is still sent to the agent as a normal message.
- 407c6e2: The dev TUI startup header is now a single `▲ eve <agent name>` brand line plus one rotating tip ("Use /channels to add more ways to reach your agent.", "Use /deploy to see your agent go live.", "Type /help to see every command."). The config rows (Model, Instructions, Tools, Skills, Subagents, Server) and the key-hints line are gone. The model moved to the status line, the empty input row shows a dim `Type to chat · / for commands` placeholder, discovery error/warning counts still render, and `eve info` keeps the full configuration detail.
- edf9f1a: Redesign the `eve dev` terminal UI and add `Client.info()`.

  The TUI now streams its transcript into the terminal's native scrollback instead of a bordered alt-screen, so scrolling, copy/paste, and the transcript all survive after you exit. The visual language follows the Vercel / Next.js CLI: a monochrome base with the `▲` brand mark, colored gutter glyphs per speaker, the `dots` spinner, and status icons (`✓` done, `⨯` error). Tool calls collapse to a one-line summary (`✓ get_weather  city="SF" → 73°F`) that expands under `--tools full`, subagent work is indented beneath a `◆` header, and a startup header prints the connected agent's model, instructions, tools, skills, and subagents. Subagents now default to `auto-collapsed`.

  The prompt input gains shell-style editing: `↑`/`↓` cycle through your previously sent messages, `←`/`→`/Home/End/`Ctrl+A`/`Ctrl+E` move the caret, and `Ctrl+U`/`Ctrl+K`/`Ctrl+W` kill the line/word. Escape sequences that arrive split across reads (common with PTYs) are reassembled, and pasted text is sanitized of stray control bytes.

  Failures read more cleanly: a terminal `session.failed` (or a dead-socket transport error) no longer leaves you stuck — the TUI starts a fresh session before the next prompt and notes it inline, so you can keep going. A failure cascade (`step.failed` → `turn.failed` → `session.failed`) renders one error block instead of three, and code bugs escaping user code show their stack trace dim beneath the headline (capped to a dozen lines; recognized provider/config failures keep their curated one-line summary). Error blocks no longer double-print a `Code: Code:` prefix and render docs links in cyan, and denied tool approvals settle to a `→ denied` line instead of a frozen `?`.

  Captured server `stdout`/`stderr` renders as quiet, indented log runs: consecutive lines from the same source coalesce behind one `stdout ·` / `stderr ·` label with a hanging indent, runs get a blank line of breathing room on both sides, and nothing is ever truncated — a transcript can't be clicked open, so the full output is always shown.

  `Client.info()` fetches the agent inspection payload (`GET /eve/v1/info`) — model id, instructions source, tools, skills, subagents, schedules, and sandbox — for both local and remote targets, returning the new `AgentInfoResult` type.

- 407c6e2: The dev TUI footer now ends with a persistent status line: the agent's model, the session's token flow (`⁕ ↑ 394.4K ↓ 4.3K`, input up, output down, `⁕ ↑ 0 ↓ 0` at startup), the linked Vercel project and team, and a `deploy pending` marker that appears when `/channels` adds a channel and clears when `/deploy` ships it. The Vercel segment stays hidden until the directory is linked. Token usage moved here from the working row, and `--context-size` appends a context-fill percentage.
- 5a6ac17: Add a required `evals/evals.config.ts` (authored with `defineEvalConfig`) that declares run-wide eval defaults: a mandatory scorer `model`, plus optional run-level `reporters`, `maxConcurrency`, and `timeoutMs`. Model-backed scorers now fall back to the config `model`, so `model` is optional on `defineEval` and a shared reporter (e.g. one `Braintrust()`) no longer needs to be repeated in every eval. CLI flags and per-eval values still take precedence over the config defaults.
- 1d65cd6: Reworked the eval authoring API around a single imperative `test(t)` function. An eval now drives the agent and asserts on what it produced in one place — `async test(t) { await t.send(...); t.completed(); t.calledTool(...); t.check(t.reply, includes(...)); t.judge.autoevals.closedQA(...).atLeast(0.6); }` — replacing the separate `run`/`input`, `checks`, `scores`, `expected`, and `thresholds` fields. Assertions carry their own severity: run-level checks and `eve/evals/expect` value assertions (`includes`/`equals`/`matches`/`similarity`) are hard gates by default, while `t.judge.autoevals.*` and `.soft(...)` assertions are tracked and only fail under `--strict`. LLM-as-judge moved under `t.judge.autoevals.*`, and the judge model is now configured via `judge: { model }` (optional) on `defineEvalConfig`/`defineEval` instead of `model`. The `eve/evals/checks` and `eve/evals/scores` entry points are removed in favor of `t`'s built-in vocabulary and `eve/evals/expect`.
- 1cf3593: Evals gain hard assertions and CI-grade pass/fail. Suites and cases accept a `checks` array (built-ins on `eve/evals/checks`: `Checks.completed`, `Checks.didNotFail`, `Checks.toolCalled` with input/output matchers, `Checks.toolOrder`, `Checks.subagentCalled`, and more); any failed check fails the case and the `eve eval` exit code, while scores stay soft unless `--strict`. Derived facts are now typed records — `toolCalls`/`subagentCalls` carry inputs, outputs, and error state (breaking: previously `string[]`), plus new `inputRequests` and `parked` fields, and `Run.didNotFail` no longer passes runs parked on HITL input. The CLI takes positional suite ids (replacing `--suite`; `--all` is removed) and adds `--tag`, `--case`, `--strict`, and `--list`. Suite `model` is now optional and only required when a model-backed scorer needs it.
- 9bb6371: Adds the evals interaction API: scripted cases, `task.run`, `EveEvalSession` helpers for HITL responses and file attachments, multi-session event capture, and client-level HITL request results with retry handling for stream registration races.
- 6fbf1e8: Evals can now verify target requirements and drive non-session surfaces. `eve eval` discovers live target capabilities from `/eve/v1/info`, supports `--mock-models`, `--no-skips`, and `--junit`, exposes `ctx.target.fetch/dispatchSchedule/attachSession`, and adds `requires` to eval and case definitions with a visible `skipped` verdict for unmet requirements.
- 6fbf1e8: Eval runner polish ahead of the e2e migration: `eve eval --verbose` streams `ctx.log` lines to stdout (and they now land in case artifacts), checks receive the same requirement-scoped target handle as the case run, JUnit failure bodies are trimmed to verdict/checks/scores, and reporter callbacks run off the case-execution hot path.
- 24c4b85: `eve channels add` now runs the channel picker, scaffold, and deploy boxes through the shared runner. The picker enforces existing-registration conflicts before writes, and the Slackbot question runs before side effects.
- a648895: Make `agent.ts` optional. Agents without an `agent.ts` now default to
  `anthropic/claude-sonnet-4.6`; when `agent.ts` is present, `model` remains required.
- e55bb46: `eve init` now accepts an existing project directory as its target (e.g. `eve init .`): the project must have a `package.json` and use npm, pnpm, or yarn (bun is not supported yet), the `agent/` files must not already exist, and the missing `eve`/`ai`/`zod` dependencies are added without touching anything else the project owns. pnpm projects additionally receive the pnpm workspace policy. In both modes the final handoff now runs the `eve dev` binary through the project's package manager instead of the project's `dev` script, which in an existing app could start unrelated processes.

  The bootstrap install disables npm's and pnpm's minimum-release-age cooldown for that single run — the scaffold pins versions younger than typical windows, so the gate would fail every fresh bootstrap. Later installs follow the project's own configuration.

- 0a8d93b: Add `eve init <name>` for non-interactive agent creation, with optional Web Chat through `--channel-web-nextjs`. The command installs dependencies, initializes Git, and starts the development server, but does not provision or deploy a Vercel project.
- 20f0fc8: New `eve link` and `eve deploy` commands, also available inside the `eve dev` TUI as `/vercel`, `/channels`, and `/deploy` when the server runs locally. `eve link` picks the Vercel team and project and pulls AI Gateway credentials into `.env.local`; `eve deploy` links when needed and remains successful when its production URL cannot be verified; AI Gateway authentication failures in the TUI now suggest `/vercel`, and the dev server picks up pulled credentials without a restart.
- 2bc514e: Share the unified select renderer, resolved-prompt rail output, BYOK provider scaffolding, and non-interactive Vercel project linking with scaffold setup flows.
- e55bb46: `eve init <name>` now scaffolds the new project with the package manager that launched it: `npx` produces an npm-managed project and `yarn dlx` a yarn one, while `pnpm dlx` and direct binary runs keep today's pnpm scaffold. Non-pnpm scaffolds no longer receive `pnpm-workspace.yaml`, `--channel-web-nextjs` requires a pnpm launch, and a bun launch is rejected until bun support lands.
- ca290a0: Remove the legacy `eve dev --repl` line-based REPL. The terminal UI is the only interactive dev UI; `--no-ui` starts the server headless. The deprecated `--no-repl` alias is no longer accepted — pass `--no-ui` instead.
- a33fa66: The dev TUI now shows dev-server rebuilds as one status row that updates in place: `tui/setup-panel.ts changed · rebuilding…`, then `· rebuilt`. Only the latest rebuild shows, paths shrink to their last two components, and the transcript no longer stacks a full log line per rebuild.
- f733fe5: The deterministic mock model adapter (`EVE_MOCK_AUTHORED_MODELS=1`) now synthesizes tool inputs for string properties anchored to quoted spans in the message (e.g. `with label "x"`), honors exact-reply fixture directives (`reply with the exact string … and nothing else`, `include the exact token … verbatim`) found in the current turn's user messages and per-turn client context, discovers static skill advertisements embedded in instruction text (not just standalone announcements), derives skill activation from `load_skill` calls in history so skills are never re-loaded in a loop, and no longer matches `load_skill` by explicit name. This widens what agent smoke evals can assert deterministically without a real model.
- 9d806d0: Add a `/model` command to the `eve dev` TUI. Run it bare to pick from a list (the running model flagged, a catalog-validated shortlist, and a freeform entry), or `/model <provider/model-id>` to set one directly. The pick rewrites `agent.ts`, and the dev server's HMR watcher applies it on the next prompt.
- 432deaa: Vercel Connect steps in Slack channel setup run under hard deadlines, so an abandoned browser OAuth can no longer stall `connect create slack` forever.
- 9061941: The dev TUI's `/model` now opens a configure menu uniting the model and provider setup, and the separate `/vercel` command is removed: "Change model" runs the searchable AI Gateway catalog picker, and "Configure provider" (bold yellow with "Required to enable the agent" until a Vercel link or gateway credential is detected) runs the provider questions `/vercel` used to ask. Each action returns to the menu, which shows each row's current value on its own line — e.g. "AI Gateway (Linked to my-project)" — and keeps the latest outcome visible beneath the options ("✓ Model changed to …"); Esc leaves. Error messages and the startup attention line now point at `/model`, and `/model <provider/model-id>` still applies a model directly.
- e55bb46: Run setup and generated-project configuration through package-manager strategies for npm, pnpm, Yarn, and Bun. `eve init --channel-web-nextjs` now works with every supported manager instead of requiring a pnpm launch.
- 22dda94: Rename the eval authoring helper from `defineEvalSuite` to `defineEval` and update the public eval types, reporter hooks, CLI wording, and JSON result shape to use eval terminology consistently.
- 5a6ac17: `defineEval` is now always a single case, with identity fully derived from the file path — `cases`, `load`, `task`, per-case `id`, and `maxConcurrency` are removed. Declare `input` or `run` (plus `expected`, `checks`, `scores`, `parseOutput`, …) at the top level, organize related evals with directory nesting (`evals/runtime/multi-turn.eval.ts` → `runtime/multi-turn`), and default-export an array of `defineEval(...)` values for dataset fan-out (ids get a zero-padded index suffix, e.g. `weather/0000`). The runner now executes eval files concurrently (default 8, `--max-concurrency`), positional `eve eval` ids match by directory prefix, `--case` is removed, reporters use a run-level lifecycle (`onRunStart`/`onEvalComplete`/`onRunComplete`), check/scorer args expose `evaluation` instead of `case`, and artifacts land under one `.eve/evals/<timestamp>/` directory per run.
- 455866d: Slack authorization prompts are now visible only to the triggering user. The default `authorization.required` handler sends the sign-in link and device code as an ephemeral message, and falls back to a public link-free status only when it has no user to target. Breaking: an `events["authorization.required"]` override now receives a private-delivery context (`postEphemeral`, `postDirectMessage`, `state`) instead of the full event context, so it can change the message but not the audience. Adds `SlackThread.postDirectMessage`, which DMs a user via `conversations.open` and requires the `im:write` scope.
- a33fa66: The dev TUI now starts with stdout and stderr logs hidden. Use `/loglevel <all|stderr|none>` to change what the transcript shows. Logs stay buffered either way, so `/loglevel all` brings back earlier output in its original order.
- 7319957: Add `createStaticSourceChange`, a central registry that lets upstream consumers (CLI, web setup UI) apply targeted edits to authored agent source. Its first operation, `updateModelName`, rewrites the `model` literal in `agent.ts` in place using oxc, preserving surrounding formatting and quote style. It bails with a source location when the value isn't a string literal, like an env reference or an inlined SDK model.
- 432deaa: Setup multi-select prompts now render checkboxes and end with a bold Submit row. Enter toggles the highlighted option, and only enter on Submit confirms, so a stray enter can no longer skip the checklist. Single-select prompts mark the highlighted row with a `›` arrow instead of a check.
- 20f0fc8: The dev TUI's bare `/model` now opens the same searchable AI Gateway catalog picker that `eve init` uses — full catalog with the featured shortlist, pre-selected on the model the runtime is serving — instead of a short hand-curated list. `/model <provider/model-id>` still applies directly.
- 20f0fc8: The dev TUI's `/vercel` now asks which model provider you want before any linking: pick AI Gateway and connect via a project or by pasting your own `AI_GATEWAY_API_KEY` (saved to `.env.local`), or pick another provider to get wiring instructions instead.

### Patch Changes

- 20f0fc8: `eve channels add` and the dev TUI `/channels` command now run `pnpm install` after recording channels, so a running `eve dev` can load newly scaffolded channel modules (for example `@vercel/connect` for Slack) immediately instead of failing to resolve them until the next deploy.
- a8363e6: Fix `authorization.required` not being emitted when a tool combines `needsApproval` with interactive auth. Approval-resume auth signals are now routed through the authorization park path instead of being replayed to the model as a plain tool result.
- a8363e6: Authorization-pending tool results no longer expose OAuth URLs, user codes, or hook URLs to the model. Channels still receive full `authorization.required` events.
- 1acc94e: Apply `build.externalDependencies` to authored module bundling and hosted output tracing, including imports from workspace packages and subagents.
- 431e5f6: Upgrade Eve's Nitro runtime dependency to `3.0.260610-beta`, picking up the latest Nitro 3 beta fixes and bundler updates.
- adc6118: Bump the AI SDK to the latest canary releases (`ai@7.0.0-canary.171`, `@ai-sdk/anthropic@4.0.0-canary.65`, `@ai-sdk/google@4.0.0-canary.80`, `@ai-sdk/mcp@2.0.0-canary.62`, `@ai-sdk/openai@4.0.0-canary.72`, `@ai-sdk/otel@1.0.0-canary.117`, `@ai-sdk/provider-utils@5.0.0-canary.47`, `@ai-sdk/react@4.0.0-canary.174`) and the Workflow packages to the latest betas (`@workflow/core@5.0.0-beta.14`, `@workflow/world@5.0.0-beta.8`, `@workflow/world-local@5.0.0-beta.15`).
- 790865c: Bump the AI SDK to the latest canary releases: `ai@7.0.0-canary.169`, `@ai-sdk/anthropic@4.0.0-canary.64`, `@ai-sdk/mcp@2.0.0-canary.60`, `@ai-sdk/openai@4.0.0-canary.71`, `@ai-sdk/otel@1.0.0-canary.115`, and `@ai-sdk/react@4.0.0-canary.172`.
- a0ca3bb: Scaffolded projects now pin `@vercel/connect@0.2.2`. The previously pinned 0.1.1 predates the `@vercel/connect/eve` entrypoint, so generated channels and connections failed to build on deploy with `Package subpath './eve' is not defined by "exports"`.
- 3af511f: Bump `@workflow/core` to `5.0.0-beta.13`.
- 02d5272: Discover Markdown-authored agent sources case-insensitively, including instructions, schedules, and packaged skills, while keeping module and directory names case-sensitive.
- c99668f: Correct the public bash tool helper export from `defineBeveTool` to `defineBashTool`.
- a0ca3bb: Fix interactive post-setup deploys failing with "The `projectSettings` object is required for new projects". The setup deploy now passes `--yes` to `vercel deploy --prod` in interactive runs too, so the Vercel API auto-detects framework settings for projects that eve provisioned through the projects API.
- 407c6e2: The dev TUI's bottom question panel (setup flows, select/text/acknowledge questions) opens with a stronger `▔` full-width rule and carries a consistent one-space left margin. Gutter glyphs sit at column 1 and text aligns at column 3 instead of touching the terminal edge.
- 20f0fc8: `eve dev` no longer clears the terminal scrollback when the terminal UI starts, and skips the redundant `server listening at` line in TUI mode — the header already shows the URL. Headless and REPL modes still print it.
- 8afd7bc: Emit `$eve.cache_write_tokens` as a per-turn observability tag, alongside the existing `$eve.input_tokens`, `$eve.output_tokens`, and `$eve.cache_read_tokens`. The value is read from the AI SDK's `usage.inputTokenDetails.cacheWriteTokens` and accumulated across tool-loop steps within a turn.
- 790865c: Empty-response recovery now also catches the AI SDK's `NoOutputGeneratedError` rejection (new in `ai@7.0.0-canary.169`): a model stream that closes without producing output is reissued once with the recovery nudge, as before, instead of failing the turn.
- e1cd134: `eve eval --url` now authenticates to remote targets with the same Vercel OIDC headers as the dev client, including the trusted OIDC IDP token that bypasses Deployment Protection — so evals can run against protected deployments without configuring a `VERCEL_AUTOMATION_BYPASS_SECRET`.
- 8aeba87: Expand the deterministic authored-model mock so smoke fixtures can exercise ask-question, bash command, loaded-skill, and subagent-token flows without live model variance.
- 20f0fc8: Make `eve init` install the current Eve release through the npm `latest` dist-tag, including when scaffolding Web Chat.
- 2aec0cf: Raise the derived `$eve.title` cap (`EVE_SESSION_TITLE_MAX_CHARS`) from 80 to 125 code points so Agent Runs titles keep more of the original prompt.
- 9a35ea7: Fix `eve init` to launch pnpm-managed projects through `pnpm exec` and generate Web Chat configuration that matches the installed Eve Next.js API.
- 5923ebc: fix(eve): prevent provider-executed tool calls from being emitted as client actions
- ca290a0: Ctrl+C during a streaming `eve dev` response now aborts the underlying HTTP stream and releases its iterator instead of leaving the connection dangling.
- 74cd2e5: Store local just-bash sandbox templates and sessions as normal on-disk directories instead of JSON filesystem snapshots, and prune stale `eve dev` runtime snapshots and local sandbox templates in the background.
- 8507473: Update Workflow SDK beta packages and isolate Eve's workflow queue traffic behind the SDK's `eve` queue namespace so co-deployed apps can use their own Workflow output without topic collisions.
- beddb37: Prepare Eve for open source: remove the internal `eve/dev-tui-test` subpath export and remove internal doc references from runtime error messages.
- 3f71a5c: Add `repository`, `homepage`, and `bugs` metadata to the published package, and ship the Apache-2.0 NOTICE file in npm tarballs.
- e1cd134: Workflow runs only route to `deploymentId: "latest"` on Vercel production. Preview and CLI deployments carry no git branch reference, so latest resolution failed with HTTP 400 ("Source deployment has no git branch") and every turn errored; they now pin workflow runs to their own immutable deployment.
- ca290a0: `eve dev` no longer clears the terminal (including native scrollback) when a source edit refreshes the agent header — the refreshed header is committed beneath the existing transcript instead.
- 8d087ff: Run the development server and terminal UI when `eve` is invoked without a command. Use `eve info` explicitly to inspect the resolved application.
- abaca02: Recover from empty model responses instead of silently ending the turn. When a model call completes with no content (finishReason 'other', e.g. an AI Gateway 200 with an empty stream), the harness reissues the call once within the same step. If the reissue also comes back empty, conversations end with a recoverable, channel-visible failure and task runs end with a failed task result rather than nothing.
- 20f0fc8: Replace removed `create-eve` and `eve setup` guidance with the current `eve init` and `eve link` commands.
- 5b69978: Fix `eve dev` source snapshots so monorepo-relative config paths and local workspace package links keep resolving from immutable dev-runtime snapshots.
- 20f0fc8: Restore the `eve link` and `eve deploy` command registrations after the `eve init` migration.
- 0a8d93b: Scaffolded projects now carry a `packageExtensions` entry in `pnpm-workspace.yaml` that restores eve's missing `oxc-parser` dependency, so fresh agents boot against the published `eve` 0.6.0-beta.13/14 builds that import it without declaring it. The entry lives in `pnpm-workspace.yaml` because pnpm 11 reads settings only from there, not from the `package.json` `pnpm` field. Remove it from the template once the scaffolded `eve` range only resolves to versions that declare `oxc-parser` themselves.
- f010437: Allow Next.js development integrations up to three minutes to start Eve by default, and support overriding the wait with the `withEve` `devServerTimeoutMs` option.
- 380693d: Token eviction on a rejected bearer now cascades to the authorization strategy's own cache, not just Eve's per-step cache. `AuthorizationDefinition` gains an optional `evict(opts)` hook, and the shared `evictScopedToken` path (used by both authored tools and MCP connections) invokes it after dropping the per-step entry. This lets `@vercel/connect`-backed connections purge their in-process token cache so a revoked-but-unexpired grant is genuinely re-fetched instead of re-read from a lower cache layer.
- ca1ca18: Per-tool authorization now evicts the rejected bearer from its per-step cache before re-running the consent flow, so a tool that re-reports `Required` (e.g. after a downstream `401`/`requireAuth()`) re-resolves a fresh token instead of re-reading the rejected one. This mirrors the MCP client's behavior. Documented the recommended pattern: map a provider `401` inside a tool's `execute` to `ctx.requireAuth()` so Eve re-challenges.
- 5e87d70: Per-tool interactive authorization never leaks a raw `Required` error into
  the model. When a tool's `auth` strategy is interactive but no callback URL
  can be minted for the run, the tool now fails with a classified
  `ConnectionAuthorizationFailedError` (`reason: "authorization_callback_unavailable"`,
  non-retryable) instead of rethrowing the raw authorization error — which the
  model would otherwise surface as a sign-in URL and loop on. Non-interactive
  strategies still rethrow their original error, since they have no consent
  flow to park on.
- 20f0fc8: Keep superseded Vercel project-name warnings inside the `/vercel` panel when linking ultimately succeeds.
- 20f0fc8: Scaffolding channels, connections, and new projects from an unstamped dev build (for example under `pnpm dev`'s watch emit) now resolves dependency versions from the live workspace catalog instead of failing with "unstamped version token". Published builds are unchanged: they are stamped at build time, and an unstamped token outside a dev tree still fails loudly.

## 0.6.0-beta.20

### Minor Changes

- 407c6e2: The dev TUI startup header is now a single `▲ eve <agent name>` brand line plus one rotating tip ("Use /channels to add more ways to reach your agent.", "Use /deploy to see your agent go live.", "Type /help to see every command."). The config rows (Model, Instructions, Tools, Skills, Subagents, Server) and the key-hints line are gone. The model moved to the status line, the empty input row shows a dim `Type to chat · / for commands` placeholder, discovery error/warning counts still render, and `eve info` keeps the full configuration detail.
- 407c6e2: The dev TUI footer now ends with a persistent status line: the agent's model, the session's token flow (`⁕ ↑ 394.4K ↓ 4.3K`, input up, output down, `⁕ ↑ 0 ↓ 0` at startup), the linked Vercel project and team, and a `deploy pending` marker that appears when `/channels` adds a channel and clears when `/deploy` ships it. The Vercel segment stays hidden until the directory is linked. Token usage moved here from the working row, and `--context-size` appends a context-fill percentage.
- 1d65cd6: Reworked the eval authoring API around a single imperative `test(t)` function. An eval now drives the agent and asserts on what it produced in one place — `async test(t) { await t.send(...); t.completed(); t.calledTool(...); t.check(t.reply, includes(...)); t.judge.autoevals.closedQA(...).atLeast(0.6); }` — replacing the separate `run`/`input`, `checks`, `scores`, `expected`, and `thresholds` fields. Assertions carry their own severity: run-level checks and `eve/evals/expect` value assertions (`includes`/`equals`/`matches`/`similarity`) are hard gates by default, while `t.judge.autoevals.*` and `.soft(...)` assertions are tracked and only fail under `--strict`. LLM-as-judge moved under `t.judge.autoevals.*`, and the judge model is now configured via `judge: { model }` (optional) on `defineEvalConfig`/`defineEval` instead of `model`. The `eve/evals/checks` and `eve/evals/scores` entry points are removed in favor of `t`'s built-in vocabulary and `eve/evals/expect`.
- a33fa66: The dev TUI now shows dev-server rebuilds as one status row that updates in place: `tui/setup-panel.ts changed · rebuilding…`, then `· rebuilt`. Only the latest rebuild shows, paths shrink to their last two components, and the transcript no longer stacks a full log line per rebuild.
- a33fa66: The dev TUI now starts with stdout and stderr logs hidden. Use `/loglevel <all|stderr|none>` to change what the transcript shows. Logs stay buffered either way, so `/loglevel all` brings back earlier output in its original order.

### Patch Changes

- 407c6e2: The dev TUI's bottom question panel (setup flows, select/text/acknowledge questions) opens with a stronger `▔` full-width rule and carries a consistent one-space left margin. Gutter glyphs sit at column 1 and text aligns at column 3 instead of touching the terminal edge.
- e1cd134: `eve eval --url` now authenticates to remote targets with the same Vercel OIDC headers as the dev client, including the trusted OIDC IDP token that bypasses Deployment Protection — so evals can run against protected deployments without configuring a `VERCEL_AUTOMATION_BYPASS_SECRET`.
- 9a35ea7: Fix `eve init` to launch pnpm-managed projects through `pnpm exec` and generate Web Chat configuration that matches the installed Eve Next.js API.
- e1cd134: Workflow runs only route to `deploymentId: "latest"` on Vercel production. Preview and CLI deployments carry no git branch reference, so latest resolution failed with HTTP 400 ("Source deployment has no git branch") and every turn errored; they now pin workflow runs to their own immutable deployment.

## 0.6.0-beta.19

### Minor Changes

- 9061941: The dev TUI's `/model` now opens a configure menu uniting the model and provider setup, and the separate `/vercel` command is removed: "Change model" runs the searchable AI Gateway catalog picker, and "Configure provider" (bold yellow with "Required to enable the agent" until a Vercel link or gateway credential is detected) runs the provider questions `/vercel` used to ask. Each action returns to the menu, which shows each row's current value on its own line — e.g. "AI Gateway (Linked to my-project)" — and keeps the latest outcome visible beneath the options ("✓ Model changed to …"); Esc leaves. Error messages and the startup attention line now point at `/model`, and `/model <provider/model-id>` still applies a model directly.

## 0.6.0-beta.18

### Minor Changes

- aa5cfdc: Connection and tool `auth` definitions accept an optional `displayName`, and authorization challenges carry it to channels — sign-in buttons now show e.g. "Sign in with Salesforce" instead of a title-cased file name. The value is presentation-only (scope, token cache keys, and callback URLs stay keyed by the path-derived name), a definition-level `displayName` wins over one the strategy stamps on the challenge, and channels keep title-casing the name when neither is set.
- e55bb46: `eve init` now accepts an existing project directory as its target (e.g. `eve init .`): the project must have a `package.json` and use npm, pnpm, or yarn (bun is not supported yet), the `agent/` files must not already exist, and the missing `eve`/`ai`/`zod` dependencies are added without touching anything else the project owns. pnpm projects additionally receive the pnpm workspace policy. In both modes the final handoff now runs the `eve dev` binary through the project's package manager instead of the project's `dev` script, which in an existing app could start unrelated processes.

  The bootstrap install disables npm's and pnpm's minimum-release-age cooldown for that single run — the scaffold pins versions younger than typical windows, so the gate would fail every fresh bootstrap. Later installs follow the project's own configuration.

- e55bb46: `eve init <name>` now scaffolds the new project with the package manager that launched it: `npx` produces an npm-managed project and `yarn dlx` a yarn one, while `pnpm dlx` and direct binary runs keep today's pnpm scaffold. Non-pnpm scaffolds no longer receive `pnpm-workspace.yaml`, `--channel-web-nextjs` requires a pnpm launch, and a bun launch is rejected until bun support lands.
- ca290a0: Remove the legacy `eve dev --repl` line-based REPL. The terminal UI is the only interactive dev UI; `--no-ui` starts the server headless. The deprecated `--no-repl` alias is no longer accepted — pass `--no-ui` instead.
- e55bb46: Run setup and generated-project configuration through package-manager strategies for npm, pnpm, Yarn, and Bun. `eve init --channel-web-nextjs` now works with every supported manager instead of requiring a pnpm launch.

### Patch Changes

- 1acc94e: Apply `build.externalDependencies` to authored module bundling and hosted output tracing, including imports from workspace packages and subagents.
- 8afd7bc: Emit `$eve.cache_write_tokens` as a per-turn observability tag, alongside the existing `$eve.input_tokens`, `$eve.output_tokens`, and `$eve.cache_read_tokens`. The value is read from the AI SDK's `usage.inputTokenDetails.cacheWriteTokens` and accumulated across tool-loop steps within a turn.
- ca290a0: Ctrl+C during a streaming `eve dev` response now aborts the underlying HTTP stream and releases its iterator instead of leaving the connection dangling.
- ca290a0: `eve dev` no longer clears the terminal (including native scrollback) when a source edit refreshes the agent header — the refreshed header is committed beneath the existing transcript instead.

## 0.6.0-beta.17

### Minor Changes

- 20f0fc8: The dev TUI's `/channels` is now an action list: pick an unregistered channel to run its add flow, return to the repainted list (added channels show locked), and leave with the Done row or Esc. Web Chat (the Next.js app) is now addable in projects that already have the scaffolded `agent/channels/eve.ts` session channel — the row locks only when the project actually depends on `next`, and the REPL channel shows as its own locked row.
- 20f0fc8: The dev TUI now discovers its slash commands: typing `/` opens a suggestion list above the prompt with each command's argument hint and description — `↑`/`↓` move the highlight, `Tab` completes, `Enter` runs, `Esc` dismisses — and a new `/help` command prints the full table. Unknown `/text` is still sent to the agent as a normal message.
- 20f0fc8: New `eve link` and `eve deploy` commands, also available inside the `eve dev` TUI as `/vercel`, `/channels`, and `/deploy` when the server runs locally. `eve link` picks the Vercel team and project and pulls AI Gateway credentials into `.env.local`; `eve deploy` links when needed and remains successful when its production URL cannot be verified; AI Gateway authentication failures in the TUI now suggest `/vercel`, and the dev server picks up pulled credentials without a restart.
- 20f0fc8: The dev TUI's bare `/model` now opens the same searchable AI Gateway catalog picker that `eve init` uses — full catalog with the featured shortlist, pre-selected on the model the runtime is serving — instead of a short hand-curated list. `/model <provider/model-id>` still applies directly.
- 20f0fc8: The dev TUI's `/vercel` now asks which model provider you want before any linking: pick AI Gateway and connect via a project or by pasting your own `AI_GATEWAY_API_KEY` (saved to `.env.local`), or pick another provider to get wiring instructions instead.

### Patch Changes

- 20f0fc8: `eve channels add` and the dev TUI `/channels` command now run `pnpm install` after recording channels, so a running `eve dev` can load newly scaffolded channel modules (for example `@vercel/connect` for Slack) immediately instead of failing to resolve them until the next deploy.
- 20f0fc8: `eve dev` no longer clears the terminal scrollback when the terminal UI starts, and skips the redundant `server listening at` line in TUI mode — the header already shows the URL. Headless and REPL modes still print it.
- 20f0fc8: Make `eve init` install the newest Eve prerelease through the npm `beta` dist-tag, including when scaffolding Web Chat.
- 20f0fc8: Replace removed `create-eve` and `eve setup` guidance with the current `eve init` and `eve link` commands.
- 20f0fc8: Restore the `eve link` and `eve deploy` command registrations after the `eve init` migration.
- 20f0fc8: Keep superseded Vercel project-name warnings inside the `/vercel` panel when linking ultimately succeeds.
- 20f0fc8: Scaffolding channels, connections, and new projects from an unstamped dev build (for example under `pnpm dev`'s watch emit) now resolves dependency versions from the live workspace catalog instead of failing with "unstamped version token". Published builds are unchanged: they are stamped at build time, and an unstamped token outside a dev tree still fails loudly.

## 0.6.0-beta.16

### Minor Changes

- 5a6ac17: Add a required `evals/evals.config.ts` (authored with `defineEvalConfig`) that declares run-wide eval defaults: a mandatory scorer `model`, plus optional run-level `reporters`, `maxConcurrency`, and `timeoutMs`. Model-backed scorers now fall back to the config `model`, so `model` is optional on `defineEval` and a shared reporter (e.g. one `Braintrust()`) no longer needs to be repeated in every eval. CLI flags and per-eval values still take precedence over the config defaults.
- 5a6ac17: `defineEval` is now always a single case, with identity fully derived from the file path — `cases`, `load`, `task`, per-case `id`, and `maxConcurrency` are removed. Declare `input` or `run` (plus `expected`, `checks`, `scores`, `parseOutput`, …) at the top level, organize related evals with directory nesting (`evals/runtime/multi-turn.eval.ts` → `runtime/multi-turn`), and default-export an array of `defineEval(...)` values for dataset fan-out (ids get a zero-padded index suffix, e.g. `weather/0000`). The runner now executes eval files concurrently (default 8, `--max-concurrency`), positional `eve eval` ids match by directory prefix, `--case` is removed, reporters use a run-level lifecycle (`onRunStart`/`onEvalComplete`/`onRunComplete`), check/scorer args expose `evaluation` instead of `case`, and artifacts land under one `.eve/evals/<timestamp>/` directory per run.

### Patch Changes

- a8363e6: Fix `authorization.required` not being emitted when a tool combines `needsApproval` with interactive auth. Approval-resume auth signals are now routed through the authorization park path instead of being replayed to the model as a plain tool result.
- a8363e6: Authorization-pending tool results no longer expose OAuth URLs, user codes, or hook URLs to the model. Channels still receive full `authorization.required` events.

## 0.6.0-beta.15

### Minor Changes

- 0a8d93b: Add `eve init <name>` for non-interactive agent creation, with optional Web Chat through `--web`. The command installs dependencies, initializes Git, and starts the development server, but does not provision or deploy a Vercel project.
- f733fe5: The deterministic mock model adapter (`EVE_MOCK_AUTHORED_MODELS=1`) now synthesizes tool inputs for string properties anchored to quoted spans in the message (e.g. `with label "x"`), honors exact-reply fixture directives (`reply with the exact string … and nothing else`, `include the exact token … verbatim`) found in the current turn's user messages and per-turn client context, discovers static skill advertisements embedded in instruction text (not just standalone announcements), derives skill activation from `load_skill` calls in history so skills are never re-loaded in a loop, and no longer matches `load_skill` by explicit name. This widens what agent smoke evals can assert deterministically without a real model.

### Patch Changes

- 0a8d93b: Scaffolded projects now carry a `packageExtensions` entry in `pnpm-workspace.yaml` that restores eve's missing `oxc-parser` dependency, so fresh agents boot against the published `eve` 0.6.0-beta.13/14 builds that import it without declaring it. The entry lives in `pnpm-workspace.yaml` because pnpm 11 reads settings only from there, not from the `package.json` `pnpm` field. Remove it from the template once the scaffolded `eve` range only resolves to versions that declare `oxc-parser` themselves.

## 0.6.0-beta.14

### Minor Changes

- 9d806d0: Add a `/model` command to the `eve dev` TUI. Run it bare to pick from a list (the running model flagged, a catalog-validated shortlist, and a freeform entry), or `/model <provider/model-id>` to set one directly. The pick rewrites `agent.ts`, and the dev server's HMR watcher applies it on the next prompt.

### Patch Changes

- c99668f: Correct the public bash tool helper export from `defineBeveTool` to `defineBashTool`.

## 0.6.0-beta.13

### Minor Changes

- fe98d0b: Compaction is now owned by the framework instead of individual tools. The per-tool `onCompact` hook (and the `CompactionInput` / `CompactionHookResult` types) is removed: the framework automatically preserves its own tool state across compaction — it resets read-before-write tracking and re-injects the active todo list. `defineReadFileTool` no longer accepts an `onCompact` option, and the agent-info response drops the now-meaningless `hasCompactionHook` field.
- 6fbf1e8: Evals can now verify target requirements and drive non-session surfaces. `eve eval` discovers live target capabilities from `/eve/v1/info`, supports `--mock-models`, `--no-skips`, and `--junit`, exposes `ctx.target.fetch/dispatchSchedule/attachSession`, and adds `requires` to eval and case definitions with a visible `skipped` verdict for unmet requirements.
- 6fbf1e8: Eval runner polish ahead of the e2e migration: `eve eval --verbose` streams `ctx.log` lines to stdout (and they now land in case artifacts), checks receive the same requirement-scoped target handle as the case run, JUnit failure bodies are trimmed to verdict/checks/scores, and reporter callbacks run off the case-execution hot path.
- 4408988: Onboarding now asks where the agent runs last, after the agent itself is described: name, model, channels, connections, then deployment (Vercel, or locally for now). Picking Slack or a Connect-backed connection resolves the deployment question to Vercel automatically with a note instead of disabling those rows up front, and scaffolding into a directory that is already linked to a Vercel project (with a logged-in CLI) skips the deployment, team, and project questions entirely — the AI Gateway authenticates through your Vercel login. The "own provider key" path now derives the scaffolded `byok` block from the model you picked (e.g. `openai/…` → `OPENAI_API_KEY`) instead of pinning the Anthropic default, and on headless `--skip-vercel` runs `--model` is now honored and validated against the AI Gateway catalog instead of being silently replaced by that default.
- 7319957: Add `createStaticSourceChange`, a central registry that lets upstream consumers (CLI, web setup UI) apply targeted edits to authored agent source. Its first operation, `updateModelName`, rewrites the `model` literal in `agent.ts` in place using oxc, preserving surrounding formatting and quote style. It bails with a source location when the value isn't a string literal, like an env reference or an inlined SDK model.

### Patch Changes

- 431e5f6: Upgrade Eve's Nitro runtime dependency to `3.0.260610-beta`, picking up the latest Nitro 3 beta fixes and bundler updates.
- adc6118: Bump the AI SDK to the latest canary releases (`ai@7.0.0-canary.171`, `@ai-sdk/anthropic@4.0.0-canary.65`, `@ai-sdk/google@4.0.0-canary.80`, `@ai-sdk/mcp@2.0.0-canary.62`, `@ai-sdk/openai@4.0.0-canary.72`, `@ai-sdk/otel@1.0.0-canary.117`, `@ai-sdk/provider-utils@5.0.0-canary.47`, `@ai-sdk/react@4.0.0-canary.174`) and the Workflow packages to the latest betas (`@workflow/core@5.0.0-beta.14`, `@workflow/world@5.0.0-beta.8`, `@workflow/world-local@5.0.0-beta.15`).
- 790865c: Bump the AI SDK to the latest canary releases: `ai@7.0.0-canary.169`, `@ai-sdk/anthropic@4.0.0-canary.64`, `@ai-sdk/mcp@2.0.0-canary.60`, `@ai-sdk/openai@4.0.0-canary.71`, `@ai-sdk/otel@1.0.0-canary.115`, and `@ai-sdk/react@4.0.0-canary.172`.
- 790865c: Empty-response recovery now also catches the AI SDK's `NoOutputGeneratedError` rejection (new in `ai@7.0.0-canary.169`): a model stream that closes without producing output is reissued once with the recovery nudge, as before, instead of failing the turn.
- 8507473: Update Workflow SDK beta packages and isolate Eve's workflow queue traffic behind the SDK's `eve` queue namespace so co-deployed apps can use their own Workflow output without topic collisions.
- 4408988: The one-shot "Next steps" note now lists the exact commands in execution order — `cd`, `pnpm install`, `vercel link` (or set `AI_GATEWAY_API_KEY` in `.env.local` manually), `eve dev` — with the commands in bold.
- f010437: Allow Next.js development integrations up to three minutes to start Eve by default, and support overriding the wait with the `withEve` `devServerTimeoutMs` option.

## 0.6.0-beta.12

### Minor Changes

- 4c1dd92: The connections picker moved into the onboarding interview: it now asks right after channel selection, before any files are written. The selected connections are still scaffolded and provisioned after the project link, exactly as before.
- 432deaa: The setup model picker now opens on a curated shortlist (Claude Sonnet 4.6 as the default, Claude Opus 4.8, GPT-5.5, and Gemini 3.5) and surfaces the rest of the AI Gateway catalog through scrolling or search. The search filter now accepts spaces. Vercel Connect steps in Slack channel setup run under hard deadlines, so an abandoned browser OAuth can no longer stall `connect create slack` forever.
- 4c1dd92: Onboarding deploys to Vercel only when the Slack channel was added — its connector needs a public production URL. A web-only onboarding run links the project but skips the deploy; Web Chat runs locally through `eve dev`. Adding channels to an existing project (`eve setup` in-project, `eve channels add`) still deploys for any channel.
- 4c1dd92: The onboarding flow now asks how much to set up after the agent name: "Complete setup" (the existing full flow, recommended) or "One-shot", which scaffolds the base template with the default model and skips provisioning, channels, deploy, and chat, ending with a next-steps note. `eve setup` in a directory that is not an Eve project now asks for the agent name and where the agent should live instead of force-scaffolding in place over the existing repo.
- 432deaa: A failed Slackbot provision no longer aborts onboarding or `eve setup`. The run warns, skips Slack, and keeps scaffolding and deploying, and you can add Slack later with `eve channels add slack`. The `eve channels add slack` command itself still fails hard, since Slack is its whole purpose.
- 432deaa: Setup multi-select prompts now render checkboxes and end with a bold Submit row. Enter toggles the highlighted option, and only enter on Submit confirms, so a stray enter can no longer skip the checklist. Single-select prompts mark the highlighted row with a `›` arrow instead of a check.

### Patch Changes

- 432deaa: Refreshed onboarding copy: the deploy question now asks where to deploy (Vercel vs. elsewhere), the team and project pickers use shorter titles, and the intro banners spell the product as 𝐞𝐯𝐞.

## 0.6.0-beta.11

### Minor Changes

- 9bb6371: Adds the evals interaction API: scripted cases, `task.run`, `EveEvalSession` helpers for HITL responses and file attachments, multi-session event capture, and client-level HITL request results with retry handling for stream registration races.
- 22dda94: Rename the eval authoring helper from `defineEvalSuite` to `defineEval` and update the public eval types, reporter hooks, CLI wording, and JSON result shape to use eval terminology consistently.

### Patch Changes

- a0ca3bb: Scaffolded projects now pin `@vercel/connect@0.2.2`. The previously pinned 0.1.1 predates the `@vercel/connect/eve` entrypoint, so generated channels and connections failed to build on deploy with `Package subpath './eve' is not defined by "exports"`.
- a0ca3bb: Fix interactive post-setup deploys failing with "The `projectSettings` object is required for new projects". The setup deploy now passes `--yes` to `vercel deploy --prod` in interactive runs too, so the Vercel API auto-detects framework settings for projects that eve provisioned through the projects API.
- 380693d: Token eviction on a rejected bearer now cascades to the authorization strategy's own cache, not just Eve's per-step cache. `AuthorizationDefinition` gains an optional `evict(opts)` hook, and the shared `evictScopedToken` path (used by both authored tools and MCP connections) invokes it after dropping the per-step entry. This lets `@vercel/connect`-backed connections purge their in-process token cache so a revoked-but-unexpired grant is genuinely re-fetched instead of re-read from a lower cache layer.

## 0.6.0-beta.10

### Minor Changes

- 24c4b85: Dissolves the scaffold engine's step flows into the setup boxes. `eve channels add` now runs the same channel boxes as onboarding through the shared runner: the picker enforces the existing-registration conflict checks directly, the slackbot question moves ahead of any file write, and prompts can never interleave with side effects.

  Removes the `eve/setup/scaffold/cli` and `eve/setup/scaffold/primitives` subpath exports. The terminal prompt adapters and process primitives now live in the setup island (`src/setup/cli/`, `src/setup/primitives/`), and the names `create-eve` consumes (`createPromptCommandOutput`, `detectDeployment`, `runPnpmInstall`, `spawnPnpm`, `runVercel`) are exported from `eve/setup` instead. The `eve/setup/scaffold` barrel is unchanged.

- 24c4b85: Route setup questions through a single ask channel. Setup boxes now ask keyed question values through one injected `Asker` whose decorator stack (interactive base, headless base, pre-supplied answers, detected/recommended policies) decides how each question resolves; the select-model, select-chat, select-channels, and resolve-target boxes migrate onto the unified single-gather contract. The channel gains a paired `askMany` method for multi-select questions (whose `T[]` answers cannot ride `ask<T>`), with option-level `locked`/`disabled` row semantics enforced both by the interactive picker and by pre-supplied answer validation. A headless run that reaches a required question without an answer now fails with a structured `InteractionRequired` error naming the question key instead of a `HeadlessPromptError`.

  The Vercel provisioning, channel-scaffold, connection, and deploy boxes now flow through that same channel: the provisioning deploy tree (deploy gate, new/link project, credential wiring, and the AI Gateway key as a sensitive text question rendered through the masked prompt), the slackbot create confirm, and the connection picker plus its custom MCP/OpenAPI sub-prompts are all keyed questions on the asker; the deploy box collapses its two constant gather faces into one. A headless run missing any required provisioning decision now refuses with `InteractionRequired` rather than `HeadlessPromptError`.

  The remaining no-prompt boxes (preflight, scaffold, detect-ai-gateway, link-project, apply-ai-gateway-credential) collapse their dual gather faces into one. Boxes whose two faces differed by mode (preflight derives a model to validate only on a headless `--model`; scaffold skips the write on a headless re-run over an existing Eve project) take a `headless` factory option fixed at the composition site, mirroring the deploy box. With every box migrated, the `SetupBox` contract is now unified-gather only: the `SetupBox` type is the single unified interface and the `LegacySetupBox`/`UnifiedSetupBox` union, the `isUnifiedSetupBox` guard, and the `InteractiveOutcome` type are gone. Both runners call `box.gather` directly; cancel is signaled solely by a thrown `WizardCancelledError`.

- 455866d: Slack authorization prompts are now visible only to the triggering user. The default `authorization.required` handler sends the sign-in link and device code as an ephemeral message, and falls back to a public link-free status only when it has no user to target. Breaking: an `events["authorization.required"]` override now receives a private-delivery context (`postEphemeral`, `postDirectMessage`, `state`) instead of the full event context, so it can change the message but not the audience. Adds `SlackThread.postDirectMessage`, which DMs a user via `conversations.open` and requires the `im:write` scope.

## 0.6.0-beta.9

### Minor Changes

- 1cf3593: Evals gain hard assertions and CI-grade pass/fail. Suites and cases accept a `checks` array (built-ins on `eve/evals/checks`: `Checks.completed`, `Checks.didNotFail`, `Checks.toolCalled` with input/output matchers, `Checks.toolOrder`, `Checks.subagentCalled`, and more); any failed check fails the case and the `eve eval` exit code, while scores stay soft unless `--strict`. Derived facts are now typed records — `toolCalls`/`subagentCalls` carry inputs, outputs, and error state (breaking: previously `string[]`), plus new `inputRequests` and `parked` fields, and `Run.didNotFail` no longer passes runs parked on HITL input. The CLI takes positional suite ids (replacing `--suite`; `--all` is removed) and adds `--tag`, `--case`, `--strict`, and `--list`. Suite `model` is now optional and only required when a model-backed scorer needs it.
- a648895: Make `agent.ts` optional. Agents without an `agent.ts` now default to
  `anthropic/claude-sonnet-4.6`; when `agent.ts` is present, `model` remains required.

### Patch Changes

- 74cd2e5: Store local just-bash sandbox templates and sessions as normal on-disk directories instead of JSON filesystem snapshots, and prune stale `eve dev` runtime snapshots and local sandbox templates in the background.

## 0.6.0-beta.8

### Patch Changes

- 02d5272: Discover Markdown-authored agent sources case-insensitively, including instructions, schedules, and packaged skills, while keeping module and directory names case-sensitive.
- 8aeba87: Expand the deterministic authored-model mock so smoke fixtures can exercise ask-question, bash command, loaded-skill, and subagent-token flows without live model variance.
- 8d087ff: Run the development server and terminal UI when `eve` is invoked without a command. Use `eve info` explicitly to inspect the resolved application.
- abaca02: Recover from empty model responses instead of silently ending the turn. When a model call completes with no content (finishReason 'other', e.g. an AI Gateway 200 with an empty stream), the harness reissues the call once within the same step. If the reissue also comes back empty, conversations end with a recoverable, channel-visible failure and task runs end with a failed task result rather than nothing.

## 0.6.0-beta.7

### Minor Changes

- edf9f1a: Redesign the `eve dev` terminal UI and add `Client.info()`.

  The TUI now streams its transcript into the terminal's native scrollback instead of a bordered alt-screen, so scrolling, copy/paste, and the transcript all survive after you exit. The visual language follows the Vercel / Next.js CLI: a monochrome base with the `▲` brand mark, colored gutter glyphs per speaker, the `dots` spinner, and status icons (`✓` done, `⨯` error). Tool calls collapse to a one-line summary (`✓ get_weather  city="SF" → 73°F`) that expands under `--tools full`, subagent work is indented beneath a `◆` header, and a startup header prints the connected agent's model, instructions, tools, skills, and subagents. Subagents now default to `auto-collapsed`.

  The prompt input gains shell-style editing: `↑`/`↓` cycle through your previously sent messages, `←`/`→`/Home/End/`Ctrl+A`/`Ctrl+E` move the caret, and `Ctrl+U`/`Ctrl+K`/`Ctrl+W` kill the line/word. Escape sequences that arrive split across reads (common with PTYs) are reassembled, and pasted text is sanitized of stray control bytes.

  Failures read more cleanly: a terminal `session.failed` (or a dead-socket transport error) no longer leaves you stuck — the TUI starts a fresh session before the next prompt and notes it inline, so you can keep going. A failure cascade (`step.failed` → `turn.failed` → `session.failed`) renders one error block instead of three, and code bugs escaping user code show their stack trace dim beneath the headline (capped to a dozen lines; recognized provider/config failures keep their curated one-line summary). Error blocks no longer double-print a `Code: Code:` prefix and render docs links in cyan, and denied tool approvals settle to a `→ denied` line instead of a frozen `?`.

  Captured server `stdout`/`stderr` renders as quiet, indented log runs: consecutive lines from the same source coalesce behind one `stdout ·` / `stderr ·` label with a hanging indent, runs get a blank line of breathing room on both sides, and nothing is ever truncated — a transcript can't be clicked open, so the full output is always shown.

  `Client.info()` fetches the agent inspection payload (`GET /eve/v1/info`) — model id, instructions source, tools, skills, subagents, schedules, and sandbox — for both local and remote targets, returning the new `AgentInfoResult` type.

## 0.6.0-beta.6

### Minor Changes

- ed176f9: Adds `eve setup`: in a fresh directory it runs the same guided onboarding as `create-eve` (name, Vercel project, model, channels, deploy); inside an existing agent it runs in-project setup. The onboarding flow now lives in the eve package as reusable setup boxes with split interactive/headless faces, and `create-eve` drives that shared flow, so the wizard behaves identically from either entry point.

### Patch Changes

- 5e87d70: Per-tool interactive authorization never leaks a raw `Required` error into
  the model. When a tool's `auth` strategy is interactive but no callback URL
  can be minted for the run, the tool now fails with a classified
  `ConnectionAuthorizationFailedError` (`reason: "authorization_callback_unavailable"`,
  non-retryable) instead of rethrowing the raw authorization error — which the
  model would otherwise surface as a sign-in URL and loop on. Non-interactive
  strategies still rethrow their original error, since they have no consent
  flow to park on.

## 0.6.0-beta.5

### Patch Changes

- ca1ca18: Per-tool authorization now evicts the rejected bearer from its per-step cache before re-running the consent flow, so a tool that re-reports `Required` (e.g. after a downstream `401`/`requireAuth()`) re-resolves a fresh token instead of re-reading the rejected one. This mirrors the MCP client's behavior. Documented the recommended pattern: map a provider `401` inside a tool's `execute` to `ctx.requireAuth()` so Eve re-challenges.

## 0.6.0-beta.4

### Patch Changes

- 2aec0cf: Raise the derived `$eve.title` cap (`EVE_SESSION_TITLE_MAX_CHARS`) from 80 to 125 code points so Agent Runs titles keep more of the original prompt.
- 5b69978: Fix `eve dev` source snapshots so monorepo-relative config paths and local workspace package links keep resolving from immutable dev-runtime snapshots.

## 0.6.0-beta.3

### Patch Changes

- 3f71a5c: Add `repository`, `homepage`, and `bugs` metadata to published packages, ship the Apache-2.0 NOTICE file in npm tarballs, and add an `exports` map and `sideEffects: false` to `create-eve`.

## 0.6.0-beta.2

### Patch Changes

- 3af511f: Bump `@workflow/core` to `5.0.0-beta.13`.
- 5923ebc: fix(eve): prevent provider-executed tool calls from being emitted as client actions
- beddb37: Prepare packages for open source: remove the internal `eve/dev-tui-test` subpath export, point the deployed home page and headless onboarding hints at the public docs site, add a README and packed CHANGELOG for `create-eve`, and remove internal doc references from runtime error messages.
