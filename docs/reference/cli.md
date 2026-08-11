---
title: "CLI"
description: "Reference for every eve CLI command: init, info, build, start, dev, logs, trace, link, deploy, eval, channels, and extension."
---

The `eve` binary (`bin: eve`) runs from your app root, and every command first loads `.env`/`.env.local` from that root. Running `eve` with no command runs `eve dev`.

## Commands

| Command                       | Description                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eve init [target]`           | Create a new agent, or add an agent to an existing project                                                                                            |
| `eve info`                    | Print the resolved application, including discovered tools, skills, subagents, schedules, channels, routes, artifact paths, and discovery diagnostics |
| `eve build`                   | Compile `.eve/` artifacts and build the host output; prints the output directory                                                                      |
| `eve start`                   | Serve the built `.output/` app; prints the listening URL                                                                                              |
| `eve dev`                     | Start the local dev server and open the terminal UI                                                                                                   |
| `eve dev <url>`               | Connect the UI to an existing server URL (e.g. a remote deployment) instead of booting a local server                                                 |
| `eve acp [url]`               | Serve the local application or an existing eve server URL as a stable ACP v1 agent over stdio                                                         |
| `eve logs [logid]`            | Print an `eve dev` diagnostic log (the most recent when `logid` is omitted)                                                                           |
| `eve logs ls`                 | List `eve dev` diagnostic logs, most recent first                                                                                                     |
| `eve traces ls`               | List locally captured agent traces, most recent first                                                                                                 |
| `eve traces [trace]`          | Show a local span tree (the most recent when omitted)                                                                                                 |
| `eve link`                    | Link the directory to a Vercel project and pull AI Gateway credentials                                                                                |
| `eve deploy`                  | Deploy the agent to Vercel production (links first if needed)                                                                                         |
| `eve eval`                    | Run evals against the local app or a remote target                                                                                                    |
| `eve channels list`           | List user-authored channels                                                                                                                           |
| `eve extension init [target]` | Create a new extension package                                                                                                                        |
| `eve extension build`         | Build the current package as an extension                                                                                                             |
| `eve model <model>`           | Change the root agent's AI Gateway model                                                                                                              |
| `eve add <item>`              | Install an item from the official or a configured shadcn registry                                                                                     |
| `eve registry <command>`      | Add sources and list, search, or view registry catalog items                                                                                          |

When `eve build` fails on discovery errors, it prints the full diagnostics report (severity, message, source path) and the diagnostics artifact path.

## `eve init`

```bash
eve init [target] [--model <provider/model-id>] [--channel-web-nextjs]
```

Creates a new agent app or adds an agent to an existing app. Always installs dependencies. New directories also initialize Git.

| Target                                    | What happens                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eve init my-agent`                       | New agent project in `my-agent/`                                                                                                                         |
| `eve init .` (or an existing project dir) | Adds `agent/` plus missing `eve`, `ai`, and `zod` deps. Needs a `package.json` and no `agent/` files yet                                                 |
| `eve init` with no target                 | Same as `eve init .`, except coding agents (Claude Code, Cursor, and similar) get a setup guide instead of scaffolding — they have not chosen a name yet |

After scaffolding, a human terminal usually continues into `eve dev`. If a coding-agent REPL is on `PATH`, the handoff menu can open it instead or exit without starting either process. Coding-agent launches print the next steps instead of opening the TUI, so the session does not get stuck. Fresh projects use the parent workspace's package manager when there is one; otherwise they use the manager that launched `eve init`.

| Flag                   | Type   | Default                     | Description                                                                                          |
| ---------------------- | ------ | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `--model <model>`      | string | `anthropic/claude-sonnet-5` | Set the root agent's AI Gateway model ID.                                                            |
| `--channel-web-nextjs` | flag   | off                         | Add the Web Chat app (Next.js). Not for existing projects — run `eve add channel/web` there instead. |

## `eve extension`

Commands for reusable [extension](/docs/extensions) packages. An extension declares distinct authoring and distribution roots in `package.json#eve.extension` (for example `"eve": { "extension": { "source": "./extension", "dist": "./dist/extension" } }`).

### `eve extension init`

```bash
eve extension init [target]
```

Creates a new extension package, installs dependencies, and initializes Git. Prints next steps instead of starting `eve dev`.

| Target                      | What happens                                                  |
| --------------------------- | ------------------------------------------------------------- |
| `eve extension init my-crm` | New extension package in `my-crm/`                            |
| `eve extension init .`      | Scaffold in the current empty directory                       |
| No target                   | Same as `.` for humans; coding agents get a short setup guide |

Create-only: cannot target an existing project that already has a `package.json`.

See [Extensions](/docs/extensions) for authoring and mount details.

### `eve extension build`

```bash
eve extension build
```

Builds the complete agent-shaped extension tree into its configured dist root, emits declarations and compatibility metadata, and fills the package `exports` map. The original TypeScript source is not required in the published package.

## Change the model

Change the root agent's AI Gateway model without opening the dev TUI:

```bash
eve model openai/gpt-5.5
```

The command writes the `provider/model-id` to `agent/agent.ts` with the same
validation and source edit as `/model openai/gpt-5.5` in the local dev TUI. It
does not configure model credentials. Models defined with `defineDynamic`, an
environment expression, or a provider-authored SDK model must be changed in
`agent.ts`.

## Registry items

Commands for installing and discovering [shadcn registry](https://ui.shadcn.com/docs/registry) items. Official registry items use a kind and slug (for example, `extension/agent-browser`); URLs and configured registry addresses are also supported.

```bash
eve add extension/agent-browser
eve add linear
eve add channel/slack --skip-install
eve add https://example.com/r/my-extension.json --overwrite
eve registry add @acme=https://example.com/r/{name}.json
eve registry search browser
eve registry search browser --limit 5
eve registry search browser --registry @acme
eve registry view @acme/my-extension
eve add @acme/my-extension
```

`eve add` asks before running setup declared by an official item and runs multiple declared flows in declaration order. Product-level packages can offer independently installable components: `eve add linear` lets you select the Linear Channel, Linear MCP, or both, with both selected by default. Interactive Vercel-backed setup signs in and creates or links a project when needed instead of stopping with a prerequisite. `--yes` installs a package's default components and accepts detected or recommended setup answers.

Coding agents should use `eve add <item> --non-interactive`, adding `--yes` to accept recommended setup values and reduce setup round trips. Explicit `--answer` values take precedence. This mode never opens an eve prompt. When a component or setup decision is missing, the NDJSON terminal event includes a stable question key and a safe continuation command; add the requested answer to that command. Supply answers with repeatable `--answer 'key=<JSON value>'` options. Follow a reported `eve link` prerequisite before retrying Vercel Connect setup. Do not put secrets in command-line answers; use the integration's documented environment variable or secret store.

When setup is skipped, cancelled, or needs more input after installation, eve prints or returns the matching `eve add <item> --skip-install` continuation. It reruns the selected components' declared flows without reinstalling registry files.

`eve registry add` records configured sources in `package.json#registries`. `eve registry list` aggregates the official catalog and all configured sources by default. `eve registry search` also includes [skills.sh](https://skills.sh), available without configuration at `@skills`, and groups results by source with each source's available result count. Search returns up to 10 matches per source by default; pass `--limit <count>` to request between 1 and 100. Either command can browse one supplied URL or namespace. Official and other universal items with explicit file targets do not require shadcn project configuration.

## `eve info`

```bash
eve info [--json]
```

| Flag     | Type | Default | Description  |
| -------- | ---- | ------- | ------------ |
| `--json` | flag | off     | Emit as JSON |

Run this first when something behaves unexpectedly. It confirms a file was discovered, lists the active surface, and surfaces discovery diagnostics, all faster than booting the dev server.

## `eve build`

```bash
eve build [--profile <path>] [--skip-sandbox-prewarm]
```

Compiles and bundles in an invocation-owned directory under `.eve/builds/`, then publishes the completed host output and prints its path. Scratch workspaces are removed after success or failure.

| Flag                     | Type   | Default | Description                                                                                   |
| ------------------------ | ------ | ------- | --------------------------------------------------------------------------------------------- |
| `--profile <path>`       | string | off     | Best-effort versioned JSON report with build-phase timings and final output-size measurements |
| `--skip-sandbox-prewarm` | flag   | off     | Skip sandbox template prewarm for a Vercel build; the output might not be deployable          |

Use a profile file to establish a repeatable baseline before changing the build pipeline:

```bash
eve build --profile .eve/build-profiles/baseline.json
```

The report is attempted only after a successful build. It records total elapsed time, completed phase timings, and final regular-file totals for file count, raw bytes, and the sum of each file compressed with gzip. For Vercel output it also includes a subtotal for every real `.func` directory, so app and flow bundles can be compared separately. The profile path resolves from the app root and should be outside the published output directory; profile collection does not add a file to the deployment. If collection or writing fails, eve emits a warning but keeps the completed build successful.

Production builds do not write through the stable compiler, host, Nitro, or Workflow files owned by `eve dev`, so builds can run while a local dev server is active. A failed build leaves the last successful `.output/` and agent summary untouched. Concurrent completed builds serialize only the final publication window.

Useful stable artifacts written by inspection and development flows under `.eve/` include:

| Artifact                                       | Description                                          |
| ---------------------------------------------- | ---------------------------------------------------- |
| `.eve/discovery/agent-discovery-manifest.json` | What eve found on disk                               |
| `.eve/discovery/diagnostics.json`              | Authored-shape errors and warnings                   |
| `.eve/compile/compiled-agent-manifest.json`    | The serialized authored surface eve loads at runtime |
| `.eve/compile/compile-metadata.json`           | Build-time metadata and paths                        |
| `.eve/compile/module-map.mjs`                  | Compiled module entrypoints eve imports at runtime   |

## `eve start`

```bash
eve start [--host <host>] [--port <port>]
```

| Flag            | Type   | Default            | Description            |
| --------------- | ------ | ------------------ | ---------------------- |
| `--host <host>` | string | all interfaces     | Host interface to bind |
| `--port <port>` | number | `$PORT`, then 3000 | Port to listen on      |

Serves the previously built output. Prints the listening URL.

## `eve dev`

```bash
eve dev [options]
eve dev https://your-app.vercel.app
```

Pass a bare URL and the UI connects to that server instead of booting a local one (same as `--url`), which lets you smoke-test a preview or production deployment. The interactive UI turns off in a non-TTY terminal.

| Flag                                | Type   | Default            | Description                                                                               |
| ----------------------------------- | ------ | ------------------ | ----------------------------------------------------------------------------------------- |
| `--host <host>`                     | string | all interfaces     | Host interface to bind                                                                    |
| `--port <port>`                     | number | `$PORT`, then 2000 | Port to listen on                                                                         |
| `-u, --url <url>`                   | string | none               | Connect to an existing server URL instead of starting one                                 |
| `-H, --header <header>`             | string | none               | Request header for a URL target, in `Name: value` form; repeat for multiple headers       |
| `--no-ui`                           | flag   | UI on              | Start the server without an interactive UI                                                |
| `--name <name>`                     | string | app folder name    | Title shown in the terminal UI                                                            |
| `--input <text>`                    | string | none               | Pre-fill the prompt input; bare local `/model` starts onboarding                          |
| `--tools <mode>`                    | enum   | `auto-collapsed`   | Tool-call rendering: `full` \| `collapsed` \| `auto-collapsed` \| `hidden`                |
| `--reasoning <mode>`                | enum   | `full`             | Reasoning rendering: `full` \| `collapsed` \| `auto-collapsed` \| `hidden`                |
| `--subagents <mode>`                | enum   | `auto-collapsed`   | Subagent-section rendering: `full` \| `collapsed` \| `auto-collapsed` \| `hidden`         |
| `--connection-auth <mode>`          | enum   | `full`             | Connection-authorization rendering: `full` \| `collapsed` \| `auto-collapsed` \| `hidden` |
| `--assistant-response-stats <mode>` | enum   | `tokensPerSecond`  | Assistant header statistic: `tokens` \| `tokensPerSecond`                                 |
| `--context-size <tokens>`           | number | none               | Model context window size, shown as a usage percentage                                    |
| `--logs <mode>`                     | enum   | `stderr`           | Server/agent logs to show: `all` \| `stderr` \| `sandbox` \| `none`                       |

`eve acp` reserves stdin and stdout for newline-delimited JSON-RPC and sends diagnostics to stderr. Without a URL, it supervises an isolated local development server. With a URL, it bridges ACP to that server's existing eve HTTP API and accepts the same URL credentials and request headers as `eve dev <url>`. Pass `--scope <team>` when the active Vercel scope does not own the deployment; `EVE_VERCEL_SCOPE` provides the same value for managed harnesses. See [Use eve through ACP](../guides/acp) for client configuration and capability limits.

A fresh `eve init` passes `--input /model`. That bare local input starts onboarding: the TUI installs the Vercel CLI if needed, asks you to log in if needed, opens `/model`, then offers categorized registry next steps before the first prompt. Other input stays editable in the prompt.

For a URL target protected by HTTP Basic auth, put the credentials in the URL. eve sends them as a Basic `Authorization` header and strips them from the server URL before connecting:

```bash
eve dev https://user:pass@your-app.example.com
```

For bearer tokens or custom schemes, pass explicit headers with `-H`.

### `eve invoke`

| Option                  | Type   | Default | Description                                     |
| ----------------------- | ------ | ------- | ----------------------------------------------- |
| `[prompt]`              | string | none    | Prompt, follow-up, or answer to a pending input |
| `-u, --url <url>`       | string | local   | Invoke an existing server                       |
| `-H, --header <header>` | string | none    | Request header for a URL target; repeatable     |
| `--resume`              | flag   | off     | Read a previous resumable result from stdin     |
| `--scope <team>`        | string | current | Vercel team that owns the URL target            |
| `--json-schema`         | flag   | off     | Print the result JSON Schema and exit           |

Use `eve invoke` to submit a turn without opening the TUI. It emits JSON after the invocation completes or reaches a blocking input or authorization event.

```bash
eve invoke "Summarize station telemetry"
result=$(eve invoke "Deploy the application")
printf '%s' "$result" | eve invoke --resume "approve"
eve invoke --json-schema
```

`--resume` reads a complete previous result from stdin. Supply text for a `ready` follow-up or pending input; the agent harness resolves input text against all pending requests. A `ready` result includes the previous turn's completed or failed `outcome`. An `authorization-required` result lists every unresolved challenge in `authorizations`; complete them, then resume without text. Pass explicit headers again for protected remote servers. If the URL belongs to another Vercel team, pass its slug with `--scope`; this does not relink the current directory. Pass the scope again when resuming. Paused invocations exit `3`; failures exit `1`.

Local callback-based connection authorization requires a persistent server. Run `eve dev`, then use `eve invoke --url <dev-url>` instead. If a waiting invocation receives `SIGINT` or `SIGTERM` after acceptance, it emits a final resumable `running` result before exiting.

Local dev records the last ready URL per resolved app root in `.eve/dev-server-state.v1.json`. A second interactive `eve dev` reconnects only when that URL is loopback and healthy; each terminal UI creates a fresh client session while sharing the server process. A stale or malformed record is replaced when eve starts a new server. Passing `--host`, `--port`, or a `PORT` environment value skips reconnection and reports a healthy recorded server instead.

Local dev keeps immutable runtime source snapshots under `.eve/dev-runtime/snapshots/` so in-flight turns hold a consistent code revision while new turns pick up rebuilds. The terminal REPL keeps its logical session across successful rebuilds, so the next turn continues the conversation on the latest generation; `/new` terminally retires that session before clearing the transcript, and the next prompt starts a fresh session with a new session-scoped sandbox on first sandbox use. After a generation is superseded, `eve dev` retains it for at least 30 minutes and also retains the five most recently superseded generations, regardless of the configured Workflow World. The active generation is never pruned. Old runtime snapshots and local sandbox templates are pruned in the background. For manual cleanup, stop `eve dev` before deleting `.eve/dev-runtime/snapshots/` or `.eve/sandbox-cache/local/templates/`. A turn that remains unfinished beyond the automatic retention window can no longer resume after its generation is pruned.

When no authored `agent/instrumentation.ts` exists, local dev also records traces under `.eve/traces/`, and bounds that store by age, size, and a keep-newest floor. Configure it with `EVE_TRACES*` in `.env.local`; see [`eve traces`](#retention) for the rules and defaults.

## `eve logs`

```bash
eve logs            # print the most recent diagnostic log
eve logs ls         # list logs, most recent first
eve logs <logid>    # print a specific log
eve logs --dump     # prepend the log's environment dump
eve logs --events   # interleave session events from the local workflow store
```

Each interactive `eve dev` process writes a private diagnostic log under `.eve/logs/` capturing stderr, stdout (including sandbox and rebuild lines), tool failures, workflow errors, and eve framework log records — regardless of what the transcript shows. The file is JSON Lines — every line is one JSON record with `at` and `source` fields. `eve logs` reads those files back.

A log id is the file name without `.log` (for example `dev-2026-07-15T12-00-00.000Z-123`). `eve logs <logid>` also accepts the file name, the `.eve/logs/...` path printed in the dev transcript, or any unambiguous prefix of the id with or without the `dev-` lead — so `eve logs 2026-07-15` works when a single log matches. An ambiguous prefix fails and lists the candidates.

`eve logs` prints nothing but records — no path banner on either stream — so `eve logs 2>&1 | jq -c .` always parses. Discover ids and file paths with `eve logs ls`; `eve logs ls --json` emits a machine-readable array with `id`, `path`, `startedAt`, and `sizeBytes`.

`eve logs --events` resolves session events (`session.started`, `turn.failed`, message deltas, …) from the local workflow store (`.eve/.workflow-data`) at query time and interleaves them into the output by timestamp as `source: "event"` records — the log file itself never stores them, so nothing is duplicated at capture time. Selection is by the log's time window (its start through the next log's start), so events from concurrently running `eve dev` processes may appear.

Each log has a same-named `.dump` sibling holding environment diagnostics and session stats as one JSON document. `eve logs --dump` (with or without a log id) prepends that document to the JSONL log body; the combined output is a valid JSON value stream (`eve logs --dump | jq -c .`), one self-contained report to attach to an issue. When a log has no dump, the flag is silently a no-op.

## `eve traces`

```bash
eve traces ls              # list traces, most recent first
eve traces ls --json       # emit machine-readable trace summaries
eve traces                 # show the most recent span tree
eve traces <trace>         # show one span tree
eve traces --verbose       # expand every span with all attributes and events
eve traces --json          # dump the full trace as JSON
```

Reads the immutable OTLP/JSON segments under `.eve/traces/v1`, so `eve dev` need not be running. Accepts a full trace id, an `agent.session.id`, or an unambiguous prefix of either. Malformed segments are skipped without hiding valid spans from the same trace.

Span rows carry inline metrics when the span recorded them — `↑input`/`↓output` token counts, gateway cost, and the tool name for `ai.toolCall` spans — and the header aggregates models, token totals, cost, and error count across the trace's step spans. `--verbose` expands each span under its tree row: status (with the error message on failures), timing, ids, every attribute (prompts, responses, and tool payloads as transcripts or pretty-printed JSON), and every span event with its offset from span start. `--json` prints the same records as JSON, one object per selected trace.

A subagent keeps its own session id but records into the trace its parent had open at dispatch, so delegated work appears under the session that caused it, tagged with `agent.root.session.id`. Either session id resolves to that trace. A remote agent traces under its own deployment and is not recorded here.

A session long enough to outgrow one trace — far longer than anything you will drive locally — continues into a new one. Each is a session window, numbered from zero on `agent.session.window`; passing a session id shows every window it produced, oldest first, and a trace id shows just that window.

One parent turn can dispatch several subagents into the same window, so a child's turn spans name the dispatch: `agent.parent.session.id`, `agent.parent.turn.id`, and `agent.parent.call_id` identify the tool call that created the child, and `agent.subagent.name` the subagent it invoked. Top-level sessions carry none of these.

Every span carries a real duration except `agent.session`: an idle session never closes, so it is recorded as a zero-duration marker and the span tree shows its descendant extent instead. A turn's span is written when the turn settles, so a running turn shows only its steps.

Model and tool-call spans carry their inputs and outputs — system prompt, prompt messages, and response text for models; call arguments and results for tools — each capped at 32 KB. Set `EVE_TRACES_CONTENT=off` to keep payloads out of the spool.

Step spans carry token counts, and cost when Vercel AI Gateway served the call. Both follow the [OTel GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) (`gen_ai.usage.*`), so a third-party backend reads them without mapping.

### Retention

eve sweeps the store when a session finishes and when the dev server starts, evicting oldest-first past the bounds below — except that the newest traces and anything written in the last five minutes are always kept, so a sweep will exceed the size budget rather than drop a trace you just recorded. Set the bounds in `.env.local`, which `eve dev` loads automatically; each accepts `off` to disable it individually.

| Variable                     | Default              | Effect                                                                                      |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| `EVE_TRACES`                 | on                   | `off` stops writing traces and stops sweeping                                               |
| `EVE_TRACES_CONTENT`         | on                   | `off` stops capturing model prompt/response and tool input/output attributes on local spans |
| `EVE_TRACES_MAX_AGE_MS`      | `604800000` (7d)     | Age after which a trace may be evicted                                                      |
| `EVE_TRACES_MAX_TOTAL_BYTES` | `536870912` (512 MB) | Size budget for the whole store                                                             |
| `EVE_TRACES_RETAIN_COUNT`    | `20`                 | Newest traces kept regardless of age or size                                                |

## `eve link`

```bash
eve link
```

Links the current directory to a Vercel project. After selecting a team, you can create a project named for the agent or link an existing project. The existing-project picker shows recent projects; type a project name and choose **Search for '<name>'** to search the rest of that team's projects. Vercel links the resolved project, eve verifies its project ID, and then pulls the project's environment so an AI Gateway credential (`VERCEL_OIDC_TOKEN` or `AI_GATEWAY_API_KEY`) lands in `.env.local`. Running it again re-links: the pickers always run, and the new choice wins. The command is interactive only; in CI, use `vercel link --project <name> --yes --non-interactive` instead. A running `eve dev` reloads env files automatically, so you don't need to restart after the pull.

## `eve deploy`

```bash
eve deploy
```

Deploys the agent to Vercel production (`vercel deploy --prod`), installing dependencies first and pulling environment variables after. An already-linked project deploys with or without a TTY (non-interactive runs pass the non-interactive `vercel` flags). When a terminal is present, an unlinked deployment signs in to Vercel if needed and then walks the `eve link` pickers; otherwise, it exits with guidance.

## `eve eval`

```bash
eve eval [evalId...] [--url <url>] [options]
```

Runs all discovered evals when no eval ids are given; ids match exactly or by directory prefix (`eve eval weather` runs everything under `evals/weather/`). Exits `0` when every eval passed its checks, `1` when any eval failed (a failed check, an execution error, or a `--strict` threshold miss), `2` on configuration errors.

| Flag                     | Type   | Default | Description                                                   |
| ------------------------ | ------ | ------- | ------------------------------------------------------------- |
| `--url <url>`            | string | none    | Remote agent URL (skip local host startup)                    |
| `--tag <tag...>`         | string | none    | Run only evals carrying a tag                                 |
| `--exclude-tag <tag...>` | string | none    | Skip evals carrying a tag                                     |
| `--strict`               | flag   | off     | Below-threshold scores also fail the exit code                |
| `--list`                 | flag   | off     | Print evals selected by the tag filters, without running them |
| `--timeout <ms>`         | number | none    | Per-eval timeout in milliseconds                              |
| `--max-concurrency <n>`  | number | 8       | Max concurrent eval executions                                |
| `--json`                 | flag   | off     | Output results as JSON                                        |
| `--junit <path>`         | string | none    | Write JUnit XML results to a file                             |
| `--skip-report`          | flag   | off     | Skip eval-defined reporters (e.g. Braintrust)                 |
| `--verbose`              | flag   | off     | Stream per-eval `t.log` lines to stdout                       |

See [Evals](../evals/overview) for authoring evals.

## `eve channels list`

```bash
eve channels list [--json]
```

Lists the user-authored channels in the current project.

| Flag     | Type | Default | Description    |
| -------- | ---- | ------- | -------------- |
| `--json` | flag | off     | Output as JSON |

## Recommended loop

1. Edit files under `agent/`.
2. `eve info` to confirm discovery or read diagnostics.
3. `eve dev` while iterating locally.
4. `eve build` before shipping.
5. `eve start` to smoke-test the built output locally.

Related: [Project layout](./project-layout) · [instrumentation.ts](../guides/instrumentation).

## What to read next

- [Project layout](./project-layout): what `eve info` discovers
- [instrumentation.ts](../guides/instrumentation): tracing and the error catalog
- [Deployment](../guides/deployment/overview): `eve build` and `eve start` in production
