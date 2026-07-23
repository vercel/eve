# eve

## 0.27.3

### Patch Changes

- 8168518: Fix connector-auth and remote-subagent callback URLs returning 404 in multi-agent mode. Generated per-agent Vercel services now bake the agent's public route prefix (`/eve/agents/<name>`) into their workflow function environment via `EVE_PUBLIC_ROUTE_PREFIX`, framework-minted callback URLs prepend it, and the session-callback validator accepts callback URLs mounted behind a route prefix so OAuth redirects and remote-subagent session callbacks reach the deployed agent.
- fecdaf3: Attach authenticated `uploads.linear.app` images from inbound Linear Agent Session markdown as multimodal file parts while preserving the text fallback for untrusted, failed, or non-image URLs.
- 25c12d3: Prevent bundler-suffixed CommonJS compatibility variables from suppressing the Node ESM globals that eve bundles need at startup.
- 1bd0aa4: Preserve underscores in connection tool names shown by Slack typing status indicators.
- 4d3748d: Keep raw outer workflow failure details in the private session trace instead of copying them into provider logs and Workflow telemetry.
- 4803dbe: Scope authored resolver hooks to relevant import specifiers and reuse filesystem probes for one build. Repeated extensionless misses now perform at most 19 stats once per plugin instance instead of on every resolution.
- d76f76b: Refresh session-scoped dynamic tools when an existing production session moves to a new Vercel deployment, so added, removed, and reordered tools use the current build.
- 45ad5d0: Analyze dynamic tool closure references from the syntax tree so object keys and string contents cannot become invalid runtime captures.
- fc53a9f: Show the number of discovered authored tools in the human-readable `eve info` output.
- 1c3123c: Write authored sandbox workspace seed files before running bootstrap across the Vercel, Docker, microsandbox, and just-bash backends, so bootstrap can consume canonical workspace inputs and its outputs remain in the captured template.
- 7094b4a: Load up to 100 Vercel teams per page and use the authenticated API continuation that matches Vercel's emitted cursor, avoiding repeated-page loops for accounts with many teams. When an outdated CLI lacks the required list options, the TUI can upgrade it with the native upgrader and now retains a concise error if that upgrade fails.

## 0.27.2

### Patch Changes

- 6c433f4: Expose thread-scoped cancellation in Slack message and interaction contexts, plus target-addressed cancellation in `onEvent`, so authored Slack handlers can stop or replace in-flight turns.
- 835f076: Emit an initial NDJSON whitespace byte when opening a session event stream so clients and proxies receive the response body before the first durable event.
- f36f143: Added `thread.listParticipants()` for Slack thread routing based on the unique human participants in first-appearance order.
- eb92ee3: Allow `session.send()` and `session.stream()` callers to disable automatic stream reconnection with `streamReconnectPolicy: { reconnect: false }`, so relays and proxies can own cursor recovery and retry policy.
- 4133ffc: Slack thread helpers now reuse messages loaded within the same inbound handler, while overlapping `thread.refresh()` calls share one request and failed refreshes preserve the last successful snapshot.
- ee72db8: Messages posted by the installed Slack app are now ignored before reaching message hooks to prevent self-reply loops.
- bd4397b: Fixed Slack `threadContext` with `since: "last-agent-reply"` so only replies from the installed app move the context boundary. Replies from other bots remain part of the incremental thread context, are labeled `bot` instead of `agent` in the injected transcript, and their file uploads are now eligible for mention attachment lookback.
- 64dbe2b: Add actionable authored-module evaluation errors that identify installed packages and distinguish extensionless ESM from missing package output while preserving the original failure as the cause.

## 0.27.1

### Patch Changes

- eaaf6d6: Enable Workflow's optimistic concurrency precondition guard in every generated Vercel workflow function so stale replays reload concurrent events before committing.
- 6ded22e: Preserve every queued delivery's message, context, and input responses when eve batches payloads before routing.
- 3ffaf12: Added a Slack `onMessage` hook with `isBotMentioned()` and `isSubscribed()` helpers for custom message routing.
- 49f2f13: Report `connection_search` as failed when every targeted connection fails to load, including authorization startup failures, so tool-call observability preserves the underlying error. Requests for unregistered connections now fail instead of returning an empty result.
- 9679abc: Added an `isSubscribed()` helper to the Microsoft Teams `onMessage` hook for custom routing that can continue conversations without repeated mentions.
- 1a618ba: Add a generic Slack `onEvent` fallback for subscribed Events API callbacks. Handlers can use a Slack-bound `receive` function to start zero, one, or many agent turns while authored mention and direct-message handlers retain precedence.
- 0df8ab9: Update the bundled AI SDK and provider integrations to their latest compatible releases.
- 394b467: Update the bundled Vercel integrations and core execution utilities to their latest compatible releases.
- f2724fb: Update the Vite integration and Vitest test tooling to their latest compatible releases.
- 01552fc: Update the bundled Workflow runtime dependencies to their latest 5.0 beta releases.
- dd1ba23: Declining a session token-budget prompt now cancels the in-flight turn cleanly (`turn.cancelled` → `session.waiting`) instead of completing the session or surfacing an error to the delegating parent. Declining a delegated child's prompt cancels the whole turn tree from the root, so the parent can no longer retry the child against a fresh quota share, and stale answers to budget prompts are dropped instead of being shown to the model. The prompt copy is reworded ("This session has hit the input-token limit (2M) per session…") with Approve/Stop buttons.
- a70d4ce: Restart native progress feedback across built-in chat channels when a completed connection authorization resumes the agent session. Slack also shows an explicit connected and resuming status.
- d3cd770: Generated Web Chat apps now retain completed sessions for follow-up messages and cancel the active durable turn when Stop is clicked instead of only disconnecting the browser stream.

## 0.27.0

### Minor Changes

- 1db41fd: `eve/nuxt` now deploys the agent through Vercel's stable services model: on Vercel builds the module generates an eve Build Output service and a `/eve/v1/*` service route instead of writing legacy `experimentalServices` to `vercel.json`, which Vercel no longer routes (every agent request returned a platform NOT_FOUND). The `configureVercelJson` and `servicePrefix` module options and the `EVE_NUXT_SERVICE_PREFIX` export were removed. Delete any generated `experimentalServices` block from `vercel.json` — the module warns when it sees one — or declare the eve service and its rewrite yourself under the stable `services` field to keep managing routing manually.

  A generated eve service build now also skips host middleware preservation when the host's Build Output config is not yet present, instead of failing the build. Unlike the Next.js integration, which writes that config early, the Nuxt web service emits it only at the end of its own build, so an isolated eve service build could crash reading a file that had no middleware to preserve.

### Patch Changes

- 707de7f: Anthropic models served through the standard `@ai-sdk/amazon-bedrock` Converse provider are now detected as cacheable. Prompt-cache breakpoints previously only matched on the provider name, so Bedrock (which reports provider `amazon-bedrock` and carries the Anthropic identity in the model id) fell through to no caching. The cache marker now also carries the Bedrock `cachePoint` namespace that the Converse provider reads.
- 7df0bf1: Compaction now reserves room for its checkpoint prompt before reaching the configured threshold. The prompt asks the compaction model to distinguish completed work from remaining work, and later compactions receive the previous checkpoint intact instead of truncating it with ordinary transcript text.
- 7df0bf1: Compaction now feeds the summarizer full-fidelity conversation text (tool payloads stay compact) and first tries evicting older tool results before summarizing; the kept recent window retains tool results verbatim. Agents lose less context per compaction and stop re-running completed tools.
- c0e368a: Routes protected by `httpBasic()` now advertise a standards-compliant `WWW-Authenticate: Basic` challenge on 401, using an optional realm that defaults to `"eve"`; HTTP Basic credentials are normalized to Unicode NFC to match the advertised UTF-8 encoding. `routeAuth` collects challenges from the configured auth strategies instead of always emitting `Bearer`.

## 0.26.2

### Patch Changes

- dbca15c: Bump the vendored chat SDK (`chat`, `@chat-adapter/*`) from 4.31.0 to 4.34.0. Slack card tables now render as native data table blocks — paginated and sortable — instead of plain table blocks, and `Table()` supports optional `caption` and `pageSize` fields.
- 938ef92: Identify Eve and its version on AI Gateway, Sandbox, and Workflow service requests.
- d034e01: Fixed the default chat message reducer dropping assistant text when a single turn produced more than one message — for example, text shown before an OAuth authorization prompt was overwritten by the text that followed it once authorization completed. Each message now renders in the order it arrived.
- dad9472: `eve info` now reports discovered subagents and schedules in both the human table and the `--json` output, matching what the CLI reference already documented. Previously both surfaces silently omitted them even though discovery resolved them correctly.
- f1253c5: Listing or loading static skills no longer requires opening a sandbox. Dynamic skills and access to supporting skill package files, such as references, assets, and scripts, remain sandbox-backed.
- de917a6: Fix a crash when an agent is triggered by a bare mention with no text (e.g. sending just `@bot` in a Microsoft Teams channel). The agent now responds normally instead of failing.

## 0.26.1

### Patch Changes

- 1f04ff7: The dev TUI renders Markdown through a real GFM parser (width-fitted tables, code blocks, task lists, links), presents every builtin tool with semantic activity copy (`Fetch <url>`, `Run <command>`, `Search <query>` — including `web_search` across provider input shapes, `todo`, `ask_question`, `agent`, and `connection_search`), and shows rejected tool approvals as denied instead of successful. Tool activity now accumulates in place: an in-flight batch renders as one counted header with its newest calls listed first behind a `│` rail and a `… (N more)` elision, then collapses to a single past-tense line (`▪ Fetched 30 URLs`) once every call settles — failures keep their itemized per-call error rail — and each `write_file` keeps its own block rendering a real line diff (`+`/`-` rows with context, computed from content the session has already seen — prior writes and full-file reads; new files show all additions). `ask_question` prompts open as a numbered overlay panel above the input (number keys select directly, the "Type your own answer" row focuses its inline editor on reach, Esc dismisses to plain text input), committing as `? question ⎿ answer` in the transcript. The `todo` tool no longer emits transcript blocks; it drives a pinned panel above the input showing per-task state, which commits as a completed block once every task settles. An empty prompt now shows a quiet `›` mark with a rotating placeholder of things to try, switching to the active `❯` once typing starts. Reasoning defaults to a fixed one-line thinking indicator that updates in place (persisting as `○ Thought for 12s` only for long thoughts; `--reasoning full` restores the streaming trace), the prompt stays anchored during a turn with Enter inert (the draft carries into the next prompt), and completed turns close with a `└ Done in <duration>` stats coda (per-turn token flow, context fill) when the turn was long or expensive. Subagent calls render as individual `※ subagent(<name>) #N` sections in the tool column whose child rows window to the three most recently active (failures stay itemized while settled work condenses to one counted row) and close on a corner that reports `Done` once the call's final message arrives; captured server output renders as one open-railed `○ stderr` / `○ stdout` stream section per source (streams are continuous — no closing corner, and interleaved activity never fragments them): the section sits at its newest write's position — everything that happened after the last error displays after it — and shows only that newest write, with earlier ones behind an `… (N more)` count (the stored-diagnostics pointer carries the history); the status bar names the model's actual routing and credential (`via ai-gateway(oidc:<project>)`, `via ai-gateway(api-key)`, or `via <provider>⌝` for a directly-authored endpoint); an empty prompt no longer submits; and a mid-conversation session replacement marks the context cut with a `┌── Session restarted, clear context.` boundary line.

## 0.26.0

### Minor Changes

- 26504e9: The client now reconnects durable event streams from their last cursor, so long turns continue across transient connection cuts without replaying events. Stream retries are now managed internally, interrupted sessions remain resumable, and `maxReconnectAttempts` has been removed from `ClientOptions`, `EveAgentStoreInit`, and the React, Svelte, and Vue `UseEveAgentOptions` APIs.

### Patch Changes

- 82fba04: Provide dynamic tools with the full auth-capable `ToolContext`, including `ctx.getToken(provider)` and `ctx.requireAuth(provider)`, across live execution and durable replay.
- 82fba04: Canonicalize Windows publication-lock watcher paths to avoid Node/libuv crashes when temporary directories use 8.3 short names.
- 51beea7: Workflow now keeps sandbox bridge capacity aligned with its configured `maxSubagents` budget, so large `Promise.all` fan-outs park and dispatch child sessions instead of failing at code mode's lower internal concurrency limit.
- 9a1800f: Fix `experimental_chatgpt` sending requests in an improper format that the
  Codex backend rejected with a 400 Bad Request: system instructions are now sent
  in the top-level `instructions` field and the unsupported `max_output_tokens`
  parameter is dropped.
- 65a7823: `eve dev` now writes a private per-process diagnostic log under `.eve/logs/` capturing stderr, stdout (including sandbox and rebuild lines), tool failures, workflow errors, and eve framework log records (stored structured, with level, namespace, and JSON fields). The file is JSON Lines: every line is one JSON record with `at` and `source` fields. Long stderr output collapses in the transcript to a one-line summary pointing at the log file (the raw text stays available in the `all` log mode), and error details reference the log instead of flooding the transcript.
- 65a7823: `eve dev` now writes an environment dump next to each diagnostic log (`.eve/logs/dev-<instance>.dump`): one JSON document capturing eve, Node.js, and Vercel CLI versions, the Vercel CLI path, local session-store size, and running session stats (prompts, token usage, tool calls by name, subagent dispatches). `eve logs --dump` prints the dump and its JSONL log together as one parseable report.
- 65a7823: The dev TUI's `/model` "Change model" row now opens a value menu — Model, Reasoning effort, Service tier, Done. Reasoning and tier adjust inline with `←`/`→` (Tab acts as `→`, both wrap as a ring): a `●─◉─○` track slides over the model's supported effort levels — snapping to the closest supported level when a pick changes what the model serves — and the tier flips between `fast ↯` and `normal`; the tier row disappears when the catalog prices no priority tier for the model. Enter on Model opens the searchable catalog as model ids on a `▏` rail — the same railed list component the team and project pickers now render with. All drafted changes commit through one atomic `agent.ts` edit. The provider picker marks and describes the currently-active provider and reports an accepted key as `AI_GATEWAY_API_KEY set.`. Linking an existing project now suggests the team project named after the agent, searching for it when it is not among the recents. Command cancellations now read "dismissed". The status line drops its `·` separators and shows the model as `slug@level ↯`.
- 65a7823: New `eve logs` command for reading the diagnostic logs `eve dev` writes under `.eve/logs/`: `eve logs` prints the most recent log, `eve logs ls [--json]` lists them, and `eve logs <logid>` prints a specific log by id, file name, transcript path, or unambiguous prefix.
- 65a7823: `eve logs --events` interleaves session events (session/turn/step lifecycle, message deltas) into the diagnostic-log output, resolved at query time from the local workflow store — nothing extra is written while `eve dev` runs.
- b53d713: Fixed transient TUI and CLI output rendering by standardizing spinners and progress rows on the shared `LiveRegion`. Streamed command output now stays aligned beneath active spinners, while failed operations preserve their command transcript for diagnostics.
- 65a7823: Errors that escape a session — not just model-call failures — now pass through a semantic-error catalog: declarative, linter-style rules applied to any thrown error. Rules cover AI Gateway (auth, model-not-found, rate limits, upstream availability), model providers (missing API keys, unsupported capabilities), the durable workflow runtime (store version/access, replay divergence, corrupted event logs), sandbox backends (Docker CLI/daemon, provisioning), and system failures (port in use, disk full, network dials). Matched failures render a stable, actionable summary in the transcript with the raw error routed to the `eve dev` diagnostic log, and failure events carry a stable `semanticErrorId` for correlation.

## 0.25.3

### Patch Changes

- 4fb1924: Fix `eve dev` snapshots for extensions installed as physical `node_modules` directories, making dependency handling consistent across npm, Yarn, and pnpm layouts.

## 0.25.2

### Patch Changes

- a4c48a9: The integrations catalog gains 4 Chat SDK adapter channels for surfaces without a first-class eve channel (Google Chat, WhatsApp, X, and Messenger), each with a `chatSdkChannel` quick start. The `eve channels add` picker is unchanged.
- d9c49fc: Tool schemas that cannot be rehydrated into local validators no longer fail the turn. Serialized JSON Schemas first retry rehydration as JSON Schema 2020-12 (so MCP `$defs` references validate correctly), and schemas outside the supported conversion subset (such as inline JSON Pointer `$ref`s) are now advertised to the model unchanged with validation left to the tool's own executor — OpenAPI operations with such schemas are kept instead of omitted.

## 0.25.1

### Patch Changes

- b2bc6b6: Make default-exported hooks emit portable extension declarations while preserving typed event handlers and authored event keys.

## 0.25.0

### Minor Changes

- b9bb8b2: Scaffold extensions with separate source and dist roots, a required wildcard eve peer, and dist-only publication. `eve extension build` now emits an agent-shaped JavaScript distribution with declarations, assets, and capability compatibility metadata instead of requiring author TypeScript in the published package.

### Patch Changes

- 29ecffc: Build mounted source-backed workspace extensions before `eve dev` compiles the agent, then rebuild only the affected extension when its source changes. Failed extension builds keep the previous dist and active development generation serving.
- 46b78b8: Stop development microsandboxes on `eve dev` shutdown by discovering resources from their run labels and loading the application's installed microsandbox version during cleanup.
- 6a5a36a: Deliver stale HITL responses — answers to a question or approval that is no longer pending — as a new user message, letting the model decide whether the old selection still matters. A stale approval never authorizes the earlier tool call.
- f7c69b1: The Vercel Framework Preset is now reconciled with the host framework on disk when running `/deploy` via the TUI.
- bbec675: Extensions installed with a registry-style store layout (e.g. from npm with pnpm) now work in `eve dev` and `eve eval`. Extension modules reached through a node_modules symlink resolve their dependencies from the package's real location — matching standard resolver semantics — instead of failing with `UNRESOLVED_IMPORT`/`ERR_MODULE_NOT_FOUND` or silently picking up another copy of the dependency from the consuming app.
- 14501dc: Every eve-owned tool input is now validated against its schema before execution, so invalid calls are returned to the model for retry instead of failing the run. Subagent calls treat an empty `outputSchema` as absent, and OpenAPI operations with invalid schemas are omitted with a warning.

## 0.24.6

### Patch Changes

- 3029647: Update the generated Web Chat template for Next.js 16.3 preview type declarations.
- b97f1d1: Custom channel routes can now cancel a session's in-flight turn: route handlers receive a `cancel({ continuationToken, turnId? })` helper addressed by the channel-local continuation token, and `Session` handles returned by `send()` and `getSession()` expose `cancel({ turnId? })` for session-id-addressed cancellation. `ClientSession.cancel()` accepts the same optional `turnId` stale-request guard.

## 0.24.5

### Patch Changes

- bfbbe92: Add `eve build --profile <path>` for a machine-readable build-timing and final-output-size report. Profile collection is best-effort, so reporting failures do not fail an otherwise successful build.
- dab9889: Allow agents to remove the root-only built-in `agent` delegation tool with `disableTool()` from `agent/tools/agent.ts`.
- e1cb505: Retry transient network failures while reopening client session streams so active turns remain attached.
- 2568387: Cancel active local, nested, and remote subagent turns when their parent turn is cancelled. Client and eval sessions can now cancel active turns directly, and eval live-turn handles can wait for typed mid-turn events before cancellation or settlement.
- 20cd9a1: Added `POST /eve/v1/session/:sessionId/cancel` to the eve HTTP channel for requesting cancellation of an in-flight turn. The optional `{ turnId }` body limits the request to the turn the caller observed; the response reports `"accepted"` when a cancellation hook accepts it or the benign `"no_active_turn"` when no resumable target exists.
- 02698fd: Fix Vercel deploys for the Next.js web channel. `eve` no longer scaffolds a
  `vercel.json` `experimentalServices` block, which the Vercel platform now
  rejects (it requires the `services` key and a stricter schema). For Next.js the
  block was also redundant — `withEve()` generates the eve service and
  `/eve/v1/*` routes into the Build Output at build time — so the scaffold now
  writes a minimal `vercel.json`.
- e45a066: `eve link` now lets you create a Vercel project or link an existing one, matching the project setup available through `/model` usage.
- 5f8818b: `eve channels add web` now updates the Vercel Framework Preset when adding a
  Next.js web channel to an already-linked eve project to prevent deployment
  failures.
- 887908c: Bundle authored modules in each development generation as one shared graph, avoiding repeated parsing and emission of dependencies for every tool.
- 376a82f: Report the root-only `agent` action alongside other framework tools in agent info, including whether it is active, disabled, or replaced.
- 4f2863d: Update the bundled Workflow runtime dependencies to their latest 5.0 beta releases.
- d9d3226: Fix `withEve` producing a broken Vercel build command in npm workspaces, where the `eve` module is located in the workspace root.

## 0.24.4

### Patch Changes

- d5db876: Session teardown now disposes authorization hooks without waiting on pending durable iterator reads, preventing cancelled sessions from hanging during cleanup.
- 0dbea62: Store local Workflow World data under `.eve/.workflow-data` for both `eve dev` and `eve start`.
- 9058962: Keep an active `eve dev` REPL session across successful authored-source reloads, so its next turn continues the durable conversation on the latest generation.
- 4531a3d: Route all of eve's single-file bundles through a shared Rolldown helper that always disables code splitting. This closes a remaining gap where a dynamic import reachable from a final workflow bundle could still fail with "Expected one bundled ..." during builds.
- b6e5923: Include the current continuation token in `session.waiting` events, and allow negative stream start indexes such as `-1` to read relative to the current tail.
- 159d674: Turns are now cancellable: resuming a session's durable cancel hook (`{sessionId}:cancel`, with an optional `turnId` guard) aborts in-flight work and settles the turn as a new `turn.cancelled` stream event followed by `session.waiting` — never as a failure. Channels and stream-event hooks can handle `turn.cancelled`, and `eve/client` finalizes partially streamed messages. The HTTP cancellation API ships in a following release.

## 0.24.3

### Patch Changes

- dddfb20: Fix `eve dev` generation bundling for authored modules whose dependencies use dynamic imports. Development generations now bundle ordinary dependencies directly instead of inheriting a copied server-external package list and tracing dependency closures; Nitro remains the sole owner of hosted dependency packaging.
- 2494b33: Bound `eve dev` runtime snapshot storage with a World-independent retention policy. Superseded generations remain available for at least 30 minutes, and the five most recently superseded generations are retained as an additional rebuild-rate safety net.
- 0333a63: Fix the dev-only schedule dispatch route to load compiled artifacts from the active development generation instead of the authored app root, which returned a 500 for every dispatch.
- 0333a63: Rework `eve dev` structural reloads to never interrupt admitted work: an isolated candidate must compile, bundle, and start before it is promoted atomically, the retired worker keeps serving the responses and sockets it already admitted until they settle, and a failed candidate or crashed worker leaves the server available with shutdown bounded even while streams are open.
- 5473f76: Keep active local Workflow turns on the development generation they selected across reloads, retries, and server restarts. New turns use the latest successful generation, and `eve dev` stores local Workflow state under `.workflow-data`.
- 0333a63: Retry transient Windows filesystem contention while atomically releasing build publication locks.

## 0.24.2

### Patch Changes

- 72ccdc0: Compaction now reserves room for its checkpoint prompt before reaching the configured threshold. The prompt asks the compaction model to distinguish completed work from remaining work, and later compactions receive the previous checkpoint intact instead of truncating it with ordinary transcript text.
- 2c12460: Tool approvals now resolve before channel context is added to the next model request, so approving a tool from channels such as Linear executes the tool instead of leaving a dangling tool call.
- d810570: Keep generated eve service builds isolated from a colocated Next.js Build Output and preserve host middleware mappings when Vercel collects the generated service.

## 0.24.1

### Patch Changes

- e0b64a5: Keep development runtime generations executable after authored source or dependencies change by bundling ordinary dependencies and materializing configured external dependency closures.
- c4f5b58: Model calls now merge multiple system instructions into one message, avoiding provider failures when dynamic instructions are combined with array-form user content.
- 6aac45d: `eve build` now uses invocation-owned compiler, host, Nitro, Workflow, and output workspaces. Concurrent builds can run beside `eve dev`, and failed builds preserve the last successfully published output.
- 0046308: Update the bundled Workflow runtime dependencies to their latest 5.0 beta releases.

## 0.24.0

### Minor Changes

- 1f85922: Replace the `ExperimentalWorkflow` marker with `experimental_workflow(options)` and move the per-program `maxSubagents` setting from `defineAgent({ limits })` to that Workflow tool definition.

### Patch Changes

- ce5c06d: `ToolContext` now exposes `toolName`, the final runtime tool name, so executors can share routing, authorization, and observability logic without duplicating path-derived or qualified names.
- e0f09b4: The `eve dev` schedule dispatch route now reuses the module loader path resolved when the server is built, preventing module resolution failures in the bundled Windows dev server.
- d194243: Fix Microsoft Teams HITL cards to show tool arguments, resume the recorded channel thread for message and invoke submissions, and authorize submissions as the Teams user who clicked the card.
- 4649f70: Local `vercel build` runs now select the hosted Workflow runtime and prewarm sandbox templates, so their output can be deployed with `vercel deploy --prebuilt`. Builds that require templates fail with setup guidance when Vercel OIDC credentials are unavailable instead of emitting broken prebuilt output.

## 0.23.0

### Minor Changes

- e5d142f: Make the built-in `agent` tool root-only, so copies created by it cannot delegate recursively. Declared subagents can still call their own nested subagents, and `limits.maxSubagentDepth` has been removed.
- 9a594c2: Infer authored channel metadata directly from the channel definition passed to `isChannel`, without compiler-generated declarations. Use `isChannel(...)` whenever you need authored metadata type narrowing; direct `channel:<name>` comparisons continue to identify channels but no longer narrow authored metadata.

  The `.eve/**/*.d.ts` TypeScript include is no longer needed. Existing apps may remove it, but leaving the unmatched glob in place does not change typechecking.

## 0.22.6

### Patch Changes

- 5035812: Vercel deployments now emit `framework: { slug: "eve" }` alongside the version in the Build Output API config. Vercel's build-output deserializer drops the entire `framework` object when `slug` is absent, so this restores framework attribution end to end — `framework_slug` and `framework_version` are now populated in AI Gateway routing and access logs.
- 9cd5c99: chatSdkChannel now mounts both GET and POST on each adapter's webhook route, so adapters that verify with a GET challenge like X's CRC check work through the bridge. POST-only adapters are unaffected.
- caa0c17: `eve dev` now keeps Nitro build inputs outside prunable runtime snapshots. Long-running development servers no longer fail structural rebuilds with stale import errors after snapshot cleanup.
- 01f0345: Resume active local workflow runs on the agent-scoped queue after restarting the eve server.

## 0.22.5

### Patch Changes

- c8f00aa: Add `experimental_chatgpt` under the new `eve/models/openai` subpath: it returns an AI SDK language model served through the local Codex login (`codex login`), billed to the ChatGPT subscription, and defaults to `gpt-5.6-sol`. Direct provider API request errors now also surface their upstream message when one is available.
- 640cd8e: Keep provider streams moving while durable event writes are in flight. eve now coalesces only adjacent queued text or reasoning appends behind an ordered writer, preserving event order while avoiding one durable round trip per provider delta.
- a5b43e7: Add `eve extension init` and `eve extension build` for scaffolding and building extension packages.
- a325195: `limits.maxSubagentDepth` now defaults to `1` instead of `3`. Agents that rely on deeper default delegation should set `limits: { maxSubagentDepth: 3 }` (or another value) explicitly.
- 4f86a21: Persist AI SDK approval-resume response messages in session history so approved local tool results survive later provider requests.
- 3577534: Update the bundled Workflow runtime dependencies to their latest 5.0 beta releases.
- bd780bd: Update the bundled Workflow runtime to `@workflow/core@5.0.0-beta.30` and align its world packages.

## 0.22.4

### Patch Changes

- b5aedaf: The shared integrations catalog gains 33 curated MCP connections from the Vercel Connect preset directory (Airtable, Stripe, Sentry, Supabase, Zapier, and more) for the docs integrations gallery, and the connection scaffolder now skips gallery-only catalog entries, so the `eve connections add` picker is unchanged.
- edc93cc: Keep the mounted extensions guide out of the docs sidebar for now. The page stays at `/docs/extensions`, but the feature isn't surfaced in the nav while its API stabilizes.
- f00f084: Add named multi-agent routing to `withEve` and `useEveAgent`. Next.js apps can now configure multiple eve roots with `agents`, then target one from the frontend with `useEveAgent({ agent: "name" })`.
- f83d47d: `defineRemoteAgent` now accepts a function for `url`, resolved at runtime instead of baked at compile time. Return a `string` (or `Promise<string>`) from `() => process.env.MY_SERVICE_URL` to target an endpoint supplied by a runtime env var, known only once the deployment runs.

## 0.22.3

### Patch Changes

- 8223498: Start remote authentication when a credentialed Vercel deployment returns an `UNAUTHORIZED` protection response.
- 79df338: feat(eve): scaffold projects with bundler module resolution

  `eve init` now writes a `tsconfig.json` using `"moduleResolution": "bundler"` (and `"module": "esnext"`), which matches how eve compiles authored agents and extensions. Relative imports in your agent and extension source no longer need `.js` extensions (e.g. `import extension from "../extension"`).

- 173fa5d: Restore the `DISCORD_BOT_TOKEN` environment fallback for proactive Discord messages, typing indicators, and bot-authenticated requests when `discordChannel()` is configured without explicit credentials.
- 89cd2d6: Eval assertion `count` options now accept predicates, allowing ranges such as “at least two” while preserving exact numeric counts.
- fdf56ef: feat(eve): mounted extensions

  Package eve capabilities — tools, connections, skills, instructions, hooks — as a reusable package and mount it under `agent/extensions/`, as a file (`crm.ts`) or a directory with co-located override slots that shadow the extension's own contributions. Contributions compose into the agent under a `<namespace>__` prefix. Author with `defineExtension` from `eve/extension`, taking an optional Standard-Schema `config` read via `extension.config`; `defineState` is auto-scoped to the package. `eve build` compiles the package to runnable JavaScript with type declarations and fills its `exports`, so a published extension installs and mounts with no second compiler. `eve` is a peer dependency whose declared range eve enforces at mount; an extension cannot declare a sandbox, agent config, schedules, or limits, or mount other extensions.

- 89f13e0: Hardened frontmatter parsing and OpenAPI connection loading.

  All frontmatter parsing now runs through a single safe-by-default helper with gray-matter's code-capable engines disabled, so a `---js` / `---javascript` fence throws instead of being `eval()`d. Previously only authored markdown (skills, schedules, instructions) was hardened; the eval YAML loader and the OpenAPI spec loader used gray-matter's defaults and would execute such a fence. This closes that path for OpenAPI specs, which are fetched over the network. Parsing untrusted frontmatter as code is now opt-in only, and a direct import of the bundled gray-matter outside the wrapper fails CI.

  OpenAPI spec URLs and the resolved base URL are now required to use `https` (plain `http` is still allowed for loopback hosts during local development), so neither the spec fetch nor the credentialed operation calls run over cleartext; the spec transport is also re-checked after redirects.

- aff35e2: Stop `eve dev` source snapshots from copying nested Git repositories and worktrees, preventing duplicate checkouts from inflating each development snapshot.
- 9087496: Prevent brokered credential values from being exposed to commands running in Microsandbox. Guest Git configuration continues to use broker-managed placeholders for authenticated requests.
- 72c58ae: Recover `eve dev <url>` authentication when Vercel Deployment Protection returns an SSO redirect or a structured protected-deployment response.
- 87688f9: Slack outbound messages now preserve literal bare `@` tokens, including scoped package names, while explicit `<@USER_ID>` mention syntax continues to pass through unchanged.
- c1c4ee5: Preserve query parameters passed to `eve dev` and send them on every agent request, including session POSTs and streams.

## 0.22.2

### Patch Changes

- 4da4d86: Fixed Anthropic prompt caching placing the final cache breakpoint one message too early. Fresh tool results were billed as uncached input every turn and only entered the cache on the following request, capping the effective cache hit rate near 50%; the breakpoint now sits on the last message of each request, so agentic tool loops get near-full prefix hits.
- 4446f96: Update the vendored Workflow SDK packages to the latest 5.0 beta releases. eve now delegates world target selection and construction to the upstream SDK instead of maintaining parallel factory and compatibility logic, and no longer disables stable Workflow Turbo mode.
- 3da5def: Retry transient provider overload errors delivered inside model streams. Classified transient failures get at most three fresh model-call attempts, while other recoverable task-mode errors fall back to Workflow's durable step retries without multiplying retry budgets.
- 2afed3b: Update `withEve()` to generate Vercel Build Output service routes for eve instead of the legacy Next.js rewrite setup. The generated output now uses the stable `services` field and service routes, including in hosted Vercel builds where no local `.vercel/project.json` exists, so Vercel builds the eve service without Next.js rewrites.
- 3983d36: The Slack channel's default typing indicator for `actions.requested` now shows the action's contents instead of a generic `Running <tool>...` label: the tool name plus its most telling argument (`grep useEveAgent`, `read_file agent/agent.ts`), the subagent or remote-agent name for dispatched calls, and `+N more` for batches. The label helpers are exported from `eve/channels/slack` as `describeActionRequest` and `describeActionRequests` for use in custom handlers.
- 15309f3: New projects created with `eve init` now use stable TypeScript 7.0.2 instead of the release candidate.

## 0.22.1

### Patch Changes

- 9c63a4e: Export `callSlackApi` and `resolveSlackBotToken` from `eve/channels/slack`. Code running outside a webhook-side handler — schedules resolving reactions or reading history, for example — has no `ctx.slack` handle; these were the internal primitives behind `slack.request`, already public-shaped and documented, and are now importable so apps stop hand-rolling `fetch` against the Slack Web API.
- 210f097: Session sandboxes are now keyed per durable session instead of per deployment, so redeploying no longer discards a session's `/workspace` state. A session gets a fresh sandbox only when the sandbox definition itself changes (authored sandbox source, workspace seed content, or `revalidationKey`), and `onSession` runs again on the replacement sandbox.
- a3efd4b: Render Slack HITL button prompts as card blocks, move approval tool input into collapsible containers, and keep answered-card updates scoped to the answered request so sibling batched approval buttons remain clickable.
- 3c6abbf: Surface authorization prompts and completion updates from local subagents on the parent channel, including through nested delegation chains, while keeping the authorization callback scoped to the child session.

## 0.22.0

### Minor Changes

- 2958abf: feat(eve): add `konsistent` with initial config to enforce structural conventions

### Patch Changes

- b7d1089: Add `defineDynamic({ fallback, events })` support for scoped dynamic agent model selection. Agents can choose a model once per session, once per turn, or per model step while keeping a compiled fallback for metadata and unset scopes.
- bd287b1: fix(eve): pass error messages when tool call input is invalid back to model instead of throwing so that it can try again

## 0.21.1

### Patch Changes

- 0b42ba1: `eve eval` now shuts down tracked sandbox handles after a local one-shot eval run completes. This prevents local sandbox compute, including microsandbox sessions, from outliving the eval process.

## 0.21.0

### Minor Changes

- 79e9959: Expand the Chat SDK channel (`chatSdkChannel`): post completed assistant messages as markdown, stream replies via post-then-edit (configurable with `streaming` and `streamingEditIntervalMs`), surface typing status on turn start and tool calls, and degrade optional adapter operations (`startTyping`, `editMessage`) gracefully when an adapter does not implement them. Add the `messageToUserContent` inbound helper and export `isNotImplemented`. The default adapter webhook route is now `/eve/v1/{adapter}`.
- 73a9bf9: feat(eve): write skills into `$HOME/.agents/skills` instead of the workspace directory

### Patch Changes

- 99c2380: Subagents now report their token usage back to the caller — local, runtime, and remote alike. A completed turn carries the session's token totals (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`) on its terminal result; remote agents transport the same totals over the session callback. The parent's turn emits one `invoke_agent` span per usage-bearing result (`gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`, `gen_ai.usage.*`, per the OpenTelemetry GenAI semantic conventions) in the caller's trace. Remote usage requires both sides to run this version; collection stays best-effort everywhere.
- c5cddb6: `message.received` events now include structured `parts` with text and file metadata so clients can render user attachments without parsing the flattened message summary. The default message reducer projects those attachments as `file` message parts while keeping raw bytes and internal sandbox paths off the stream.
- 5ef4ec6: Reintroduce the `ExperimentalWorkflow` opt-in marker in `eve/tools`. Re-exporting it from `agent/tools/workflow.ts` enables the `Workflow` orchestration tool, which can spawn the agent's subagents from model-authored JavaScript. Workflow-spawned subagent calls are now capped per program by the new `limits.maxSubagents` agent setting (default 100) — calls beyond the budget resolve with a `WORKFLOW_SUBAGENT_LIMIT_REACHED` error result instead of starting a child session — and the tool stays root-only, so delegated subagent sessions never receive it.
- 61745d5: Slack channel posts that combine Markdown and file uploads now send the Markdown message first and upload files as a threaded follow-up. This preserves Slack's full Markdown rendering, including tables, instead of downgrading the response into a file upload comment.
- d408d0b: Reaching a session token limit no longer fails interactive sessions outright. The harness now pauses and sends a deterministic HITL continuation prompt; answering "Continue" grants a fresh budget window of the configured size, while "Stop" ends the session gracefully with `session.completed`. Task-mode sessions keep the structured `SESSION_TOKEN_LIMIT_REACHED` failure so parent tool calls receive an error result.
- da2ec6c: Delegated subagent sessions now receive a share of the parent's remaining token quota at dispatch time — the remainder split across the batch's delegated calls — instead of a fixed 5M input-token cap, and a completed child's usage counts against the parent's quota, so a delegation tree can never outspend the budget configured at its root. Session token limits also accept `false` to uncap a session explicitly. Delegated children likewise inherit the parent's delegation caps (`limits.maxSubagentDepth` and `limits.maxSubagents`); on every inherited axis the tighter of the configured and inherited value wins.

## 0.20.0

### Minor Changes

- 6f9364a: Sandboxes are now stopped when the eve server shuts down. Self-hosted production servers stop every open sandbox (microsandbox VMs, Docker containers, Vercel sandboxes, just-bash interpreters) on `SIGTERM`/`SIGINT`, matching the cleanup `eve dev` already performs, and sessions reattach from persisted state on the next start. Breaking change for custom sandbox backends: `SandboxBackendHandle` gains a required `shutdown()` and the unused `dispose()` is removed.

### Patch Changes

- 7699e98: `eve eval` now prints a clear, actionable message when it finds no evals but detects `*.eval.ts` files placed inside `agent/`. Instead of the generic "No evals found", it names the offending directories and reminds you that eval files belong in the top-level `evals/` directory (a sibling of `agent/`).
- f3a05c5: `ToolContext` and `ApprovalContext` now expose `callId`, the tool call id carried by the call's stream events, so approval-gated tools can key records to one identity across proposal, rejection, and execution.
- f9621b6: Resuming a durable session whose history references a file attachment no longer fails the turn when the staged bytes are gone (for example after a redeploy pointed the session at a fresh sandbox). The missing attachment degrades to a `FileNotFound` text notice the model can interpret, so the run continues instead of ending in `session.failed`.
- c233a6a: The turn harness now propagates a cooperative `AbortSignal` end to end: model calls, retries, recovery, compaction, and tool executions all honor it, and an aborted turn settles with a canonical `TurnCancelledError` that is never retried or misclassified as a failure. Authored tools receive the signal as `ctx.abortSignal` (and via the AI SDK execute options), and framework tools forward it into sandbox commands, file I/O, `web_fetch`, and MCP/OpenAPI connection calls. This is the lowest layer of turn cancellation — no trigger exists yet, so runtime behavior is unchanged until the cancellation API ships.

## 0.19.0

### Minor Changes

- 92f5162: add generic chat sdk channel for adapter-backed agents

### Patch Changes

- 8892504: Render the deployment home page with the eve SVG wordmark, baked-in agent name, and refined ready-state layout.
- 3daaba0: Reduce development runtime snapshot disk usage by excluding `.env*`, generated dependency, and build output directories, using clone-friendly file copies where supported, and pruning stale snapshots after dev rebuilds.
- 74ce164: reuse chat sdk twilio primitives for webhook, api, and voice helpers
- c0a0ae2: Terminal model-call failures in delegated subagent runs (e.g. an unresolvable model id returning 404) now propagate to the parent as a failed subagent result instead of a successful empty output, so orchestrator sessions no longer report success when a delegation failed.
- 0498252: Tool execution failures now return failed tool results to the model instead of leaving streamed tool calls without matching result history. Agents can recover from failed calls such as a missing `load_skill` target within the same turn.

## 0.18.2

### Patch Changes

- c5da8e7: Sandbox API requests now append an `eve/<version>` token to the `user-agent` so the sandbox control plane can attribute traffic to eve.

## 0.18.1

### Patch Changes

- 68365e8: Show tool call input in Slack approval prompts so operators can inspect approval-gated actions before approving.
- 68365e8: Harden Slack HITL posting against API limits: large approval batches now split across multiple messages instead of exceeding Slack's 50-block cap, and long freeform answers are truncated so the answered-card update cannot fail.

## 0.18.0

### Minor Changes

- a75dd47: Vercel sandbox: drop the `runtime` option. eve now always boots its hosted sandboxes from the published eve image.

### Patch Changes

- afc7ded: Allow `eve dev` to start from a package-less flat agent that only has `instructions.md`. Development runtime snapshots now generate private package metadata when the authored app has none.
- 7d1084d: fix(eve): remove unnecessary preview deployment check that prevented production access from `eve dev`
- 63f94f0: Remove optional framework peer dependencies from the published package metadata so installs no longer resolve unused framework packages.
- ba2e0ce: Create new Vercel projects through `vercel link` instead of posting directly to the projects API. This lets the Vercel CLI apply its framework and local config handling while eve reads the resulting link metadata, keeps framework-specific eve host integrations when detected, and otherwise ensures new projects use the eve framework preset.

## 0.17.2

### Patch Changes

- afa22f8: Cap recursive subagent delegation at three child-session levels by default, configurable with `defineAgent({ limits: { maxSubagentDepth } })`. At the limit, eve no longer advertises subagent tools and blocks stale delegated calls before starting another child session.
- 55e9ad5: Update the scaffold's default agent model to `anthropic/claude-sonnet-5`. New agents created with `eve init` (and the setup model picker's pre-selected default) now use Claude Sonnet 5 instead of Claude Sonnet 4.6.
- f26d600: use Chat SDK Slack format primitives for Slack mrkdwn conversion
- 087d6fd: use chat sdk slack api primitives for slack channel api helpers
- 70ebe69: use Chat SDK Slack webhook primitives for Slack channel parsing and verification
- ed8a935: Keep the `Workflow` orchestration tool root-only. Delegated subagent sessions can still call visible subagent tools directly until the configured depth cap, but eve no longer advertises `Workflow` from those child sessions.
- 37bd2bb: Use authored `eveChannel()` auth for `GET /eve/v1/info` so remote `eve dev` can authenticate with the same policy as the session routes.
- 2fdc561: Add `limits.maxInputTokensPerSession` and `limits.maxOutputTokensPerSession` to stop a durable session from starting more model calls after its accumulated provider-reported input or output token usage reaches the configured cap. Root sessions default to a 40M input-token budget, delegated subagent sessions default to 5M, and authored input limits override those defaults.
- 39c90de: Add explicit `dev:eve`, `build:eve`, and `start:eve` scripts to generated Web Chat projects so users can run the embedded eve app directly when needed.

## 0.17.1

### Patch Changes

- 97aa99b: Add HTTP Basic userinfo and repeatable `-H, --header` support to `eve dev` URL targets so the terminal UI can send credentials or routing headers to protected remote deployments.
- c7827fb: Stop injecting subagent tool descriptions into delegated child prompts. Child runs now receive only the caller's delegated message plus the stable subagent invocation wrapper.
- 739af96: Update eve's bundled Workflow SDK dependency set to the latest 5.0.0 beta releases, keeping the core package and local workflow world aligned.

## 0.17.0

### Minor Changes

- 02ed501: Remove the experimental `ExperimentalWorkflow` opt-in marker from the public `eve/tools` API and remove the dynamic Workflow docs. The internal runtime path remains in place for existing compiled manifests, but authored apps can no longer enable the tool through the public API.

### Patch Changes

- 6dc84fc: Keep Telegram proactive private chat sessions keyed to their chat or topic after outbound sends, while group and supergroup proactive sends still anchor to the bot message id.

## 0.16.2

### Patch Changes

- 9580a88: Disable the Workflow SDK turbo first-delivery path for eve. Workflow runs now stay on the fully ordered runtime path instead of the beta turbo mode.

## 0.16.1

### Patch Changes

- 8470695: HTTP channels can now opt into browser CORS with preflight handling. Use `defineChannel({ cors })` for custom channels or `eveChannel({ cors: true | options })` for the eve channel; omitted CORS remains disabled.
- aa3aca4: The GitHub channel now accepts Vercel Connect-forwarded webhook payloads that omit `x-github-event` and `x-github-delivery` by inferring the supported event type from the payload shape. Headerless forwarded payloads now emit a warning with the inferred metadata instead of being silently acknowledged and ignored.
- 8713a71: Fix human-in-the-loop approval resume behavior so text replies like `approve` resolve pending tool approvals and unrelated follow-up messages no longer synthesize a denial. Rejected approval results now include explicit approval and not-run metadata for clients.
- 7fd53f7: Update the curated Linear MCP connection to use Linear's Streamable HTTP endpoint at `https://mcp.linear.app/mcp`. The MCP and OpenAPI connection docs now include fuller setup guidance for Vercel Connect, static credentials, filters, and approvals.
- c0f9749: Fix Vercel Connect local interactive connection authorization when the dev server uses an IPv4 or IPv6 loopback address. OAuth callbacks now retain the active port while using the `localhost` hostname accepted by Connect, and local `/connect` refreshes the dev runtime before the next prompt can use the new connection.
- c14b022: The `eve dev` TUI retries one transient agent-inspection failure before treating a local or remote agent as unavailable.

## 0.16.0

### Minor Changes

- 24faac0: Add a searchable `/connect` flow to the local dev TUI. It scaffolds an MCP connection, resolves its Vercel Connect connector, and reuses the model setup flow to create or link a Vercel project when needed. Local Vercel users now authorize Connect with their Vercel user ID instead of a reserved OIDC issuer.

### Patch Changes

- ddda14c: Fresh agents now start model setup from their prefilled `/model` prompt, installing the Vercel CLI and logging in when those prerequisites are missing. Other `eve dev` sessions leave missing model setup as an attention prompt.
- ca8512a: Generated projects now emit peer-resolution metadata only for their selected package manager. pnpm scaffolds no longer include npm or Yarn fields that can make frozen Vercel installs fail.

## 0.15.5

### Patch Changes

- 8078807: Render authorization prompts in the default web chat projection. Scaffolded web UIs now show OAuth sign-in affordances from `authorization.required` events and update them when authorization completes.

## 0.15.4

### Patch Changes

- da83b03: Slack assistant-thread status text now strips lightweight Markdown before calling Slack, so model progress updates like `**Considering turbo tasks**` display without literal formatting markers.
- 5b31627: Add a deterministic `mockModel` eval helper with static, prompt-aware, and tool-calling responses.
- 2e00da7: Scope workflow queue prefixes to each eve agent so multiple uniquely named agents can deploy in the same project without consuming one another's workflow messages.
- 86ae773: Clarify Vercel build failures when an agent pins the Docker or microsandbox sandbox backend. The error now explains those local backends are unavailable on Vercel and directs users to `defaultBackend()` or an explicit Vercel-compatible backend.

## 0.15.3

### Patch Changes

- d8449cf: Keep provider-managed web search calls replayable when the model emits narration before results or when the provider returns an error.

## 0.15.2

### Patch Changes

- f1abdfd: Deduplicate repeated durable turn dispatches through turn-inbox ownership so a duplicate child workflow no longer fails the active session.
- f1abdfd: Keep each logical turn active while local or remote subagents run, including while proxying child input requests, so child completion resumes the same turn instead of starting a replacement turn.

## 0.15.1

### Patch Changes

- b049756: Use the active eve development server URL for connection authorization callbacks. Local Vercel Connect flows now return to eve's actual port instead of Workflow's port 3000 fallback.
- 2933ab2: The local `eve dev` status bar now shows a gray `:port` badge and retains it as terminal width narrows. Status segments now use tighter spacing.
- 2e4e15d: `eve init` now accepts `--yes` as a no-op compatibility flag and warns before continuing.
- 2933ab2: Running `eve dev` interactively now reconnects to the healthy loopback dev server recorded for the same app root, with a fresh session for each attached terminal UI. Eve replaces stale or malformed state when it starts a new server. `--host`, `--port`, or `PORT` skips reconnection and reports a healthy recorded server instead.

## 0.15.0

### Minor Changes

- 194a8bb: Add snapshot-based turn and session assertions, lifecycle-aware tool and subagent matching, typed event checks, recorded requirements, and explicit skipped results. The simplified API uses `succeeded`/`parked`, completed calls by default, exact `count` options, and `require*` lookups so evals no longer need manual event scans or thrown assertion errors.

### Patch Changes

- f618bef: New Vercel project names now show the suggested name as a placeholder, so typing replaces it instead of editing a prefilled value.
- 194a8bb: Make `isChannel` recognize authored channel imports evaluated in a different local runtime bundle from the route instance.
- d83b418: eve's health endpoint (`/eve/v1/health`) now responds to `HEAD` requests, not just `GET`, so load balancers and uptime monitors that probe with `HEAD` (UptimeRobot, Kubernetes probes, and others) no longer report a healthy deployment as down.
- e5ccf93: Self-hosted `eve start` now registers the workflow queue handler for custom (non-Vercel) worlds, so jobs dispatched by a configured world no longer return `Unhandled queue` or leave runs stuck `pending` — and you no longer need `eve dev --no-ui` to run a local world in production. eve also fails fast at boot with an actionable error when a configured workflow world's `@workflow/*` version is incompatible with the line eve bundles, instead of surfacing a cryptic `ZodError` deep in workflow replay.
- 3865605: Stream `actions.requested` as each model tool call arrives, before the tool finishes or a runtime action is dispatched.

## 0.14.0

### Minor Changes

- 78ef30a: Standardize authored tools and connections on an `approval` function that receives the active session context and returns AI SDK 7 approval statuses, with synchronous and asynchronous policies supported. Boolean results remain supported as aliases for user approval and no approval, schedules no longer accept approval configuration, and no AI SDK 6 `needsApproval` adapter remains.
- 5c32eb0: Remove `defineAgent({ experimental: { codeMode } })` and the `EVE_EXPERIMENTAL_CODE_MODE` fallback. Tools are always exposed directly to the model; model-authored JavaScript orchestration remains available through the experimental `Workflow` tool for subagents and remote agents.

### Patch Changes

- a3d8441: Fix dynamic `Workflow` fan-out so concurrent subagent calls dispatch together, replay in deterministic program order, and resume reliably across runtime isolates. Generated pnpm workspaces now exempt the bundled code-mode package from release-age gating so fresh eve releases install immediately.
- 91e43ae: Upgrade eve to the stable AI SDK 7 release and copy vendored AI SDK declarations directly from the installed packages. Newly scaffolded pnpm workspaces now exempt the AI SDK, Vercel, and Workflow package families from minimum release age checks.
- 89969b2: Add a top-level `defineAgent({ reasoning })` option that forwards provider-agnostic reasoning effort to the agent's turn model calls.
- 5c32eb0: Strengthen the built-in `agent` tool guidance so models know when and how to split large tasks across a fixed batch of parallel recursive calls.
- 7c532fe: MCP and OpenAPI connections can now resolve `auth` providers and headers from the active session context, enabling per-caller and per-tenant credentials.
- 72b3d0e: Keep Slack sender ids attached to their message text and add an opt-in `threadContext` setting that injects ID-attributed thread replies since a configurable boundary. Workflow titles retain the original Slack text, while later turns and authorization prompts consistently use the current caller.

## 0.13.8

### Patch Changes

- 9d72bb1: Seed session, subagent, and turn workflow attributes when their runs are created so Workflow turbo mode cannot race tag writes against run creation.

## 0.13.7

### Patch Changes

- c8014d1: Improve Vercel Connect-backed connection auth by allowing authored definitions to include the `evict` hook and clarifying `principal_required` guidance when user-scoped connections run without an authenticated user principal.
- ff44c4c: Clarify scaffolded guidance for locating bundled eve package docs in workspaces and local installs.
- 30c5965: Preserve dynamic tool approval gates when session- and turn-scoped tools are replayed from durable metadata. If a replayed approval callback cannot be recovered, eve now requires approval by default instead of silently running the tool unguarded.
- 55af52e: Acknowledge Slack view submissions with an empty response body so submitted modals close without an error.
- dd960df: Fix Vercel CLI detection on Windows by invoking npm's command shims through `cmd.exe`, so an installed `vercel` command is no longer misreported as missing.

## 0.13.6

### Patch Changes

- 7f66a06: Add opt-in GitHub channel hooks for check suite, check run, and workflow run webhooks, with normalized CI metadata and pull request dispatch.
- a63dfa2: Project search now resolves exact names directly and ranks one fallback result page, avoiding unbounded substring-match pagination for short queries.
- a63dfa2: Fixed remote `/vc:login` rejecting a freshly resolved Vercel project with "The local Vercel OIDC token does not match the resolved deployment: owner_id." The verified deployment now takes its owner id from Vercel's response instead of the team slug used to scope the lookup, so it matches the OIDC token's `owner_id` claim.
- a63dfa2: In remote sessions, `/vc:login` resolves the target Vercel project and owning team from the deployment URL. When the target requires authentication and Vercel cannot resolve its host in the active scope, the flow asks you to select another team, then reruns the lookup in that scope. When access is denied, for example because a team SSO session expired, it re-authenticates and retries.
- a63dfa2: Remote `eve dev --url` now treats `/eve/v1/info` as best-effort inspection rather than a connection gate. Once authentication succeeds and the deployment is reachable, the session connects even when the agent info route is absent (confirmed via the public health route) or returns an unrecognized shape (e.g. a deployment built from an older eve). Inspection-only data is simply omitted from the header in that case, and the underlying parse failure now names the offending fields instead of an opaque message.
- a63dfa2: Remote `eve dev --url` sessions now show deployment and authentication state, try refreshed project-scoped OIDC credentials at startup, and open a cancellable `/vc:login` recovery flow when access is rejected. The flow can update the target project's Trusted Sources after confirmation.
- c5071e6: Ensure every eve Workflow runtime entrypoint installs the eve queue namespace through a single guarded boundary.
- c9e895b: Fix `eve dev` streaming throughput and time-to-first-token degrading as parked (`ask_question` / HITL) sessions accumulate. The dev runtime's NDJSON event-stream reader now forwards cancellation to the underlying run stream, so disconnecting from a parked session no longer leaks a filesystem polling loop for the life of the dev server.
- c6b2da8: Add `$eve.channel_request_id` workflow attributes from Vercel's `x-vercel-id` header so session and turn workflow runs can be joined back to the inbound request that started or resumed them.
- ab3e6e8: Give each threadless proactive Slack session a unique temporary continuation token so overlapping scheduled runs targeting the same channel do not conflict before they anchor to a Slack thread.
- a63dfa2: The dev TUI's `/vc` and `/login` commands are now `/vc:install` and `/vc:login`. `/vc:login` is the single Vercel authentication command: it logs in locally and, in remote (`eve dev --url`) sessions, recovers access with Vercel OIDC.

## 0.13.5

### Patch Changes

- c927ecd: Confirm continuation-token ownership before an agent turn starts or a session re-keys. Competing sessions now fail before processing input, and successful delivery reports the hook owner atomically.
- 5f0f69f: Use Parallel through AI Gateway for the built-in `web_search` tool with every string model. Gateway requests no longer select native provider search tools or pin routing to a model provider.
- 430ed8c: Teach agents that conditionally delivered work can finish successfully without sending a message. Polling schedules can now intentionally skip delivery without treating an accidental blank model response as success.
- 25b1b14: fix(eve): catch unserializable tool output values instead of sending them to the model

## 0.13.4

### Patch Changes

- efca390: Make optional sandbox engine loading more resilient after auto-install. eve now
  probes installed engine packages in a cache-isolated worker, checks ancestor
  `node_modules` directories for workspace-hoisted installs, and reports a clear
  post-install diagnostic when an engine package still cannot be loaded.
- 7079d08: Bundle client-safe vendored dependencies in a neutral chunk group so `eve/react` can use the Zod-backed `/eve/v1/info` validator without pulling in Node-only vendored runtime helpers.
- 598b5e0: Clear pending connection/tool authorization state after a matching callback resumes a session, so Slack threads do not keep waiting for already-completed auth and swallow follow-up messages.
- 9298c90: Upgrade the Workflow development packages to their latest beta releases.

## 0.13.3

### Patch Changes

- b33c611: use shared Chat SDK Block Kit primitives for Slack card rendering

## 0.13.2

### Patch Changes

- d82e8d1: Consolidate model provider setup into one choice between project-backed AI Gateway, an inline `AI_GATEWAY_API_KEY`, and direct provider credentials. Gateway key validation now reports its latest result inline without leaving stale errors in the setup panel.
- b29e2ae: Remote clients can now send Vercel OIDC credentials through a dedicated auth mode and reject malformed agent metadata before using it.

## 0.13.1

### Patch Changes

- 9d8bd6e: Existing production sessions now refresh their system prompt from the latest deployment before each model step. Long-lived channel conversations retain their history and state while adopting updated agent instructions.

## 0.13.0

### Minor Changes

- 306e14e: Remove the top-level `auth` field from `defineTool()` and require tool auth providers to be passed inline to `ctx.getToken(provider)` or `ctx.requireAuth(provider)`.
- f00ca73: Search every Vercel project in the selected team and preserve the selected project ID through linking.

### Patch Changes

- 36b67fc: Make `eve init` respect ancestor package-manager workspaces when scaffolding nested packages. The scaffold now updates workspace-owned package policy at the npm, pnpm, Yarn, or Bun workspace root instead of writing nested root-only config into the generated package.

## 0.12.3

### Patch Changes

- 680ff48: Text prompts now use block cursors, while active turns and model or channel setup use shared green progress pulses.
- 27a9701: Resolve extensionless relative imports whose target basename contains dots when bundling authored modules. Local files such as `./mock-registry.schemas` and dependency requires such as `./Reflect.getPrototypeOf` now probe Eve's configured `.ts` and `.js` extensions before being treated as asset imports.
- 3a64a8f: `eve init` with no target, when run by a coding agent, now prints a setup guide — what to ask the user, then the scaffold command — instead of scaffolding the current directory. The guide routes both channels (Slack credentials) and connections (per-user OAuth) through Vercel Connect so credentials are provisioned rather than hand-managed. `eve init <name>` and `eve init .` are unchanged.
- 3a64a8f: `eve init` now offers to open an installed coding-agent REPL when its CLI is on `PATH`, while keeping `eve dev` as the default. It detects Claude Code, Codex, Cursor, Droid, Gemini CLI, opencode, and Pi. The selected REPL starts with a project-specific setup prompt and `eve dev --no-ui` verification guidance. Coding-agent and non-interactive launches, plus systems without any supported CLI, keep the existing development-server handoff.
- 86a35eb: Add inline tool auth provider overloads so tools can call `ctx.getToken(provider, options?)` and `ctx.requireAuth(provider, options?)` without declaring a single top-level `auth`. Vercel Connect providers can be authored inline with `connect("service/agent")` or `connect({ connector, tokenParams })`; the existing top-level tool `auth` field and no-argument tool auth accessors remain supported for compatibility, but are now deprecated in favor of inline providers.
- 25ab1e7: Preserve dev-runtime snapshots that are still referenced by local durable workflow data so parked HITL turns can resume after `eve dev` rebuilds.
- 504f59e: Allow `eve eval` target checks to match a scoped package name such as `@acme/agent` against the runtime agent identity `agent`.
- 0dca794: Restore Slack authorization status updates by posting a link-free public status while sending the sign-in challenge privately, then updating the public status when authorization completes.
- 3548363: Strengthen Vercel and just-bash process streaming with deterministic completion, safe output cancellation, and idempotent process operations.

## 0.12.2

### Patch Changes

- 8f7d97b: Keep Vercel Sandbox option types synchronized with the installed SDK by vendoring its upstream declaration files instead of maintaining a hand-written copy. Vercel-backed file reads now convert provider Node streams to Eve's public Web stream contract.

## 0.12.1

### Patch Changes

- 3f3a86b: Improve conversation compaction for longer, more reliable sessions.
- e296fb8: The dev TUI now opens `/model` when the runtime confirms no model provider is configured and refreshes model access after setup. Selected rows now use padded inverse labels with a filled arrow.
- f68ecbe: Set the Eve Vercel framework preset when creating standalone Eve projects.
- c084232: Verify remote Vercel deployment origins against the owner and project supplied by `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`, or by a local project link, before sending ambient credentials. Remote dev and eval clients now refresh scoped OIDC tokens per request and refuse to forward credentials across redirects. Remote `eve dev` and `eve eval --url` targets now require `https://` (loopback hosts may still use `http://`).

## 0.12.0

### Minor Changes

- 7df41e1: Dynamic map resolvers no longer auto-prefix entries with the file slug — the map key is the tool/skill name verbatim (a single `defineTool`/`defineSkill` is still named after the file slug). Namespace keys yourself (e.g. `team__playbook`) when a bare name might collide. A dynamic tool/skill overrides a same-named authored one; two dynamic resolvers emitting the same name now throw, recommending manual namespacing. Connection tools are renamed accordingly: the search tool is `connection_search` and discovered tools are `<connection>__<tool>` (e.g. `linear__list_issues`).

### Patch Changes

- 10e9237: Fix code-defined models under `eve dev`, including NodeNext `.js` imports that target authored `.ts` files. Runtime model resolution now reuses the active agent bundle's module map and node scope, so child agents resolve their own models without rebuilding authored modules on each step.

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
