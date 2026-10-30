---
title: "CLI"
description: "Reference for every eve CLI command."
---

The `eve` CLI scaffolds, runs, inspects, and deploys agents. Run it from the application root or any directory beneath it. Running `eve` with no command runs `eve init` outside an eve project and `eve dev` inside one.

## Commands

| Command                                        | Description                                            |
| ---------------------------------------------- | ------------------------------------------------------ |
| `eve init [target]`                            | Create a new agent, or add one to an existing project  |
| `eve dev`                                      | Start the local development server and terminal UI     |
| `eve remote connect --url <url>`               | Open the terminal UI or print one remote response      |
| `eve remote info --url <url>`                  | Inspect an existing agent                              |
| `eve acp [url]`                                | Serve a local or existing agent through ACP over stdio |
| `eve info`                                     | Inspect the local application                          |
| `eve set model [model] [--reasoning <effort>]` | Change model and reasoning settings                    |
| `eve build` / `eve start`                      | Build or serve the application                         |
| `eve logs show [logid]` / `eve logs list`      | Inspect local diagnostic logs                          |
| `eve traces show [trace]` / `eve traces list`  | Inspect local traces                                   |
| `eve link` / `eve deploy`                      | Link or deploy a Vercel project                        |
| `eve eval`                                     | Run evals against a local or remote target             |
| `eve add [item]` / `eve registry <command>`    | Install and browse registry items                      |
| `eve extension <command>`                      | Create and build extension packages                    |
| `eve telemetry <command>`                      | Manage CLI telemetry collection                        |

## CLI telemetry

eve collects CLI telemetry by default. Run `eve telemetry disable` to turn it off for this machine, or set `EVE_TELEMETRY_DISABLED=1` for one command. See [CLI telemetry](./telemetry) for collected fields, exclusions, debug mode, and preference storage.

## `eve init`

```bash
eve init [target] [--model <provider/model-id>] [--reasoning <effort>] [--non-interactive]
```

Creates a new agent app or adds an agent to an existing app. It always installs dependencies, and initializes Git in new directories.

| Target                                                                                                     | What happens                                                                                                           |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `eve init my-agent`                                                                                        | Creates an agent project in `my-agent/`                                                                                |
| `eve init` or `eve init .` in an empty directory                                                           | Creates an agent project in the current directory                                                                      |
| `eve init` or `eve init .` in a directory with files other than environment metadata and no `package.json` | Refuses to overwrite the directory. Pass a new directory name, such as `eve init my-agent`                             |
| `eve init` or `eve init .` in an existing project                                                          | Adds `agent/` plus missing `eve`, `ai`, and `zod` dependencies. Requires `package.json` and no existing `agent/` files |
| `eve init path/to/app`                                                                                     | Adds an agent to the existing package at `path/to/app`                                                                 |

In non-interactive environments, a new project needs a directory name such as `eve init my-agent`. A nested path such as `eve init apps/my-agent` creates missing parent directories.

In an interactive terminal, eve opens the TUI after scaffolding. Pass `-n` or `--non-interactive` to return instead; dependency installation and Git setup still run. Non-interactive and coding-agent invocations always return without starting a session.

New projects use the parent workspace's package manager, or the one that launched `eve init` when there is no workspace.

| Flag                    | Type   | Default                                              | Description                                                                                                                   |
| ----------------------- | ------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--model <model>`       | string | `openai/gpt-6-luna-fast`                             | Set the root agent's AI Gateway model ID.                                                                                     |
| `--reasoning <effort>`  | enum   | `high` without `--model`; otherwise provider default | Set reasoning to `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`. `provider-default` leaves the field unauthored.      |
| `--agents <names>`      | string | unset                                                | Create a new workspace with comma-separated agent names, such as `support,research`, or add members to an existing workspace. |
| `-y, --yes`             | flag   | off                                                  | Has no effect and prints a warning.                                                                                           |
| `-n, --non-interactive` | flag   | off                                                  | Scaffold and install dependencies without starting development.                                                               |

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

It cannot target a directory that already has a `package.json`. `-y` and `--yes` have no effect and print a warning.

See [Extensions](/docs/extensions) for authoring and mount details.

### `eve extension build`

```bash
eve extension build
```

Builds the extension's agent files into its configured `dist` root. It also writes type declarations and compatibility metadata, and fills the package `exports` map. The original TypeScript source is not required in the published package.

## Set model settings

`eve set model` changes the root agent's AI Gateway model, reasoning effort, or both, without opening the dev TUI:

```bash
eve set model openai/gpt-6-sol --reasoning high
eve set model --reasoning medium
```

Omit the model argument to keep the current model. eve writes both settings to `agent/agent.ts` in one source edit. `--reasoning` accepts `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`; `provider-default` removes the authored `reasoning` field.

The command validates and edits like `/model` in the dev TUI, and doesn't configure model credentials. It can't rewrite a model defined with `defineDynamic`, an environment expression, or a provider SDK model; change those in `agent.ts`. `--reasoning` still updates the root config when its model comes from an SDK call.

## Registry items

`eve add` and `eve registry` install and discover [shadcn registry](https://ui.shadcn.com/docs/registry) items. Official items use a kind and slug, such as `extension/agent-browser`; URLs and configured registry addresses also work.

```bash
eve add extension/agent-browser
eve add channel/linear
eve add channel/slack --skip-install
eve add https://example.com/r/my-extension.json --overwrite
eve registry add @acme=https://example.com/r/{name}.json
eve registry search browser
eve registry search browser --limit 5
eve registry search browser --registry @acme
eve registry view @acme/my-extension
eve add @acme/my-extension
```

`eve add` asks before running an official item's declared setup, and runs multiple flows in declaration order. Interactive Vercel-backed setup signs in and creates or links a project when needed. `--yes` accepts detected or recommended answers.

Coding agents should run `eve add <item> --non-interactive --yes`. This mode never prompts. When a setup decision is missing, the final NDJSON event includes a stable question key and a continuation command. Add the answer to that command as a repeatable `--answer 'key=<JSON value>'` option, which takes precedence over `--yes`. Follow a reported `eve link` prerequisite before retrying Vercel Connect setup. Don't put secrets in answers; use the integration's documented environment variable or secret store.

When setup is skipped, cancelled, or needs more input, eve prints or returns an `eve add <item> --skip-install` continuation. It reruns the item's setup flows without reinstalling registry files.

`eve registry add` records sources in `package.json#registries`. `eve registry list` shows the official catalog and all configured sources. `eve registry search` also searches [skills.sh](https://skills.sh) as `@skills`, and groups results by source with each source's result count. Search returns up to 10 matches per source; pass `--limit <count>` for 1 to 100. Pass `--registry` to list or search one URL or namespace. Official and other universal items with explicit file targets don't need shadcn project configuration.

## `eve info`

```bash
eve info [--json]
```

| Flag     | Type | Default | Description  |
| -------- | ---- | ------- | ------------ |
| `--json` | flag | off     | Emit as JSON |

Run `eve info` first when something behaves unexpectedly. It shows which files eve found and what the agent includes, and reports discovery diagnostics without starting the dev server. Static instructions appear in source order with their `system` or `user` role; dynamic instructions are runtime-only and don't appear.

### JSON output

`eve info --json` prints one JSON object, so scripts and CI checks don't need to read files under `.eve/`:

| Field              | Type             | Description                                                                               |
| ------------------ | ---------------- | ----------------------------------------------------------------------------------------- |
| `appRoot`          | string           | Application root                                                                          |
| `agentRoot`        | string or `null` | Agent directory, or `null` when the project could not be compiled                         |
| `layout`           | string or `null` | Project layout                                                                            |
| `status`           | string           | Compile status, such as `ready` or `failed`; `unavailable` when nothing compiled          |
| `diagnostics`      | object or `null` | Discovery diagnostic counts: `{ errors, warnings }`                                       |
| `model`            | string or `null` | Root agent model id                                                                       |
| `instructions`     | string or `null` | Static instruction files with their roles                                                 |
| `skills`           | string[]         | Static skill names                                                                        |
| `tools`            | string[]         | Root agent tool names                                                                     |
| `toolInputSchemas` | object           | Each tool's input schema as eve sends it to the model (see below)                         |
| `subagents`        | string[]         | Declared subagent names                                                                   |
| `schedules`        | string[]         | Schedule names                                                                            |
| `channels`         | object[]         | Effective channel routes: `{ name, kind, method, urlPath }`                               |
| `messaging`        | object           | Session route patterns: `{ create, messages, stream }`                                    |
| `artifacts`        | object or `null` | Paths to the compiled manifest, discovery manifest, diagnostics, module map, and metadata |

`toolInputSchemas.root` maps each root agent tool name, including namespaced extension tools, to its JSON Schema. `toolInputSchemas.subagents` holds the same map for each declared subagent, keyed by its path from the root. For example, a `reviewer` that `forecaster` declares is `forecaster/reviewer`.

Each schema is the form eve sends to the model:

- Validation-library schemas such as Zod set `additionalProperties: false` on closed objects.
- Plain JSON Schema stays as written.
- Tools that run as `serve` tasks, including agent tools, include the optional `taskId` input.

```json
{
  "tools": ["get_weather"],
  "toolInputSchemas": {
    "root": {
      "get_weather": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"],
        "additionalProperties": false
      }
    },
    "subagents": {
      "forecaster": {},
      "forecaster/reviewer": {
        "check_source": {
          "type": "object",
          "properties": { "url": { "type": "string" } },
          "required": ["url"],
          "additionalProperties": false
        }
      }
    }
  }
}
```

`toolInputSchemas` covers only tools compiled from tool files. It omits provider-managed tools such as `web_search`, dynamic tools, connection tools, the runtime-generated subagent and remote agent tools, and `eve__task_wait` and `eve__task_cancel`. It also doesn't reflect transformations a model provider applies before the model reads a schema.

## `eve build`

```bash
eve build [--profile <path>] [--skip-sandbox-prewarm]
```

Compiles and bundles the agent, prepares sandbox artifacts, writes the host output, and prints its path. When discovery fails, it prints the full diagnostics report (severity, message, source path) and the diagnostics artifact path.

Pass `--skip-sandbox-prewarm` when you only need compiled output, such as before a separate typecheck. Don't deploy that output, because it might not start its configured sandbox.

Bundles preserve custom Node.js resolution conditions from `--conditions`, `-C`, or `NODE_OPTIONS`, so compilation and the bundle resolve each package to the same export. For example, `NODE_OPTIONS="--conditions=react-server" eve build` selects the `react-server` export of packages that publish one.

eve loads `server-only` and `client-only` imports as empty modules. Code shared with a Next.js app can keep them without a resolution condition or a dependency on either package.

| Flag                     | Type   | Default | Description                                                                                   |
| ------------------------ | ------ | ------- | --------------------------------------------------------------------------------------------- |
| `--profile <path>`       | string | off     | Best-effort versioned JSON report with build-phase timings and final output-size measurements |
| `--skip-sandbox-prewarm` | flag   | off     | Skip sandbox preparation; the output might not be deployable                                  |

Use a profile to establish a baseline before changing the build pipeline:

```bash
eve build --profile .eve/build-profiles/baseline.json
```

eve writes the profile only after a successful build. It records total time, phase timings, and the output's file count, raw bytes, and per-file gzip bytes. Vercel output adds a subtotal for each `.func` directory, so app and flow bundles compare separately. Self-hosted output adds `deploymentId`, the content-derived build identity. eve passes it to the Workflow World as `WORKFLOW_DEPLOYMENT_ID` when that variable isn't set. The profile path resolves from the app root; keep it outside the published output directory. A collection or write failure emits a warning without failing the build.

Builds can run while a dev server is active and alongside other builds. A failed build leaves the last successful `.output/` and agent summary untouched.

Inspection and development flows write these stable artifacts under `.eve/`:

| Artifact                                       | Description                                        |
| ---------------------------------------------- | -------------------------------------------------- |
| `.eve/discovery/agent-discovery-manifest.json` | What eve found on disk                             |
| `.eve/discovery/diagnostics.json`              | Authored-shape errors and warnings                 |
| `.eve/compile/compiled-agent-manifest.json`    | The compiled agent definition eve loads at runtime |
| `.eve/compile/compile-metadata.json`           | Build-time metadata and paths                      |
| `.eve/compile/module-map.mjs`                  | Compiled module entrypoints eve imports at runtime |

## `eve start`

```bash
eve start [--host <host>] [--port <port>] [--no-schedules]
```

| Flag             | Type   | Default            | Description                                   |
| ---------------- | ------ | ------------------ | --------------------------------------------- |
| `--host <host>`  | string | all interfaces     | Host interface to bind                        |
| `--port <port>`  | number | `$PORT`, then 3000 | Port to listen on                             |
| `--no-schedules` | flag   | schedules on       | Start without running authored cron schedules |

Serves the built output and prints the listening URL.

Set `EVE_SCHEDULES_DISABLED=1` or `true` (case-insensitive) to disable authored cron schedules at runtime. This also applies when you run `node .output/server/index.mjs` directly. Other values leave schedules on. HTTP requests and workflow jobs still run, and eve prints a `schedules disabled` line. `--no-schedules` sets the variable to `1` for the spawned server only; omit it to keep any value you set.

Use this setting when [scaling self-hosted replicas](../guides/deployment/self-hosted-operations#run-schedules). It also disables authored cron dispatch on Vercel if set there, but not explicit schedule dispatch in `eve dev`.

For self-hosted deployments, copy the app source, `.output/`, and installed dependencies together. Preserve the relative layout of workspace packages, because startup loads sandbox modules from the deployed source. The deployment directory can differ from the build directory.

## `eve dev`

```bash
eve dev [options]
```

Starts a local development server and terminal UI. To connect the UI to an existing agent, use `eve remote connect --url <url>`.

| Flag                                | Type   | Default            | Description                                                     |
| ----------------------------------- | ------ | ------------------ | --------------------------------------------------------------- |
| `--host <host>`                     | string | `127.0.0.1`        | Host interface to bind                                          |
| `--port <port>`                     | number | `$PORT`, then 2000 | Port to listen on                                               |
| `--no-ui`                           | flag   | UI on              | Start the server without an interactive UI                      |
| `--resume`                          | flag   | off                | Attempt recovery of retained runs from previous dev invocations |
| `--no-default-extensions`           | flag   | extensions on      | Do not mount bundled development extensions                     |
| `--name <name>`                     | string | app folder name    | Title shown in the terminal UI                                  |
| `--input <text>`                    | string | none               | Pre-fill the prompt input                                       |
| `--show-tools <mode>`               | enum   | `auto-collapsed`   | Tool-call rendering                                             |
| `--show-reasoning <mode>`           | enum   | `auto-collapsed`   | Reasoning rendering                                             |
| `--show-subagents <mode>`           | enum   | `collapsed`        | Subagent task rendering: `full`, `collapsed`, or `hidden`       |
| `--show-connection-auth <mode>`     | enum   | `full`             | Connection-authorization rendering                              |
| `--assistant-response-stats <mode>` | enum   | `tokensPerSecond`  | Assistant header statistic                                      |
| `--context-size <tokens>`           | number | none               | Model context window size                                       |
| `--logs <mode>`                     | enum   | `error`            | Display `none`, `error`, `warn`, `debug`, or `all` logs         |

`localDev()` refuses callers connecting from another machine. When `--host` binds another interface, such as `0.0.0.0`, those callers need another authenticator in the channel's `auth` list. A same-machine tunnel or reverse proxy, such as ngrok, cloudflared, or a local nginx, connects locally. eve authenticates every caller it forwards as `local-dev`, so put an authenticator in front of any dev server you expose that way.

Bundled development extensions mount without adding files to your project; pass `--no-default-extensions` to disable them. See [Self-Modification](../guides/self-modification).

A fresh `eve init` opens the TUI and reuses an available model connection or opens `/login`; chat needs no Vercel project, channels, or integrations. Use `/model` to change models and settings, and `/add` to install an addition. `--input` text stays editable in the prompt. See [Terminal UI](../guides/dev-tui) for credential precedence and login options.

### Local development lifecycle

A second interactive `eve dev` for the same app root reconnects to the running server when it is on loopback and healthy. Each terminal UI gets a fresh client session on the shared server. Passing `--host`, `--port`, or a `PORT` value skips reconnection and reports the running server instead.

Each rebuild saves a snapshot of the built code under `.eve/dev-runtime/snapshots/`. In-flight turns finish on the code they started with, and new turns use the latest rebuild. The terminal REPL keeps its session across rebuilds, so the next turn continues the conversation. `/new` ends that session and clears the transcript; the next prompt starts a fresh session with a new sandbox.

With any Workflow World, eve keeps each replaced snapshot for at least 30 minutes, and keeps the five most recently replaced snapshots. It never prunes the active snapshot. eve prunes old snapshots and local sandbox templates in the background, and a turn left unfinished past the retention window can't resume. To clean up manually, stop `eve dev` before deleting `.eve/dev-runtime/snapshots/` or `.eve/sandbox-cache/local/templates/`.

Local dev records traces under `.eve/traces/`, bounded by age, size, and a keep-newest floor. Configure the store with `EVE_TRACES*` in `.env.local`, or disable it with `agent/instrumentation/local.ts`; see [`eve traces`](#retention).

`eve acp` reserves stdin and stdout for newline-delimited JSON-RPC and sends diagnostics to stderr. Without a URL, it supervises an isolated local development server. With a URL, it bridges ACP to that server's existing eve HTTP API. See [Agent Client Protocol (ACP)](../protocols/acp) for client configuration and supported features.

### Local workflow recovery

With the built-in local Workflow World, a new `eve dev` server leaves runs from previous invocations dormant. Their timers and hooks don't fire. A message or control request to a dormant conversation fails instead of being accepted without a response; the HTTP channel reports its usual request failure. Start a new conversation, or restart with `eve dev --resume`. Already-open event streams are unaffected, and rebuilds and worker restarts within one server keep current runs eligible.

`eve dev --resume` attempts to recover unfinished runs from previous invocations that have a retained snapshot with readable metadata. Framework or workflow source changes don't block the attempt, but replay can fail and leave the run terminally failed after executing some work.

Runs with malformed snapshot metadata stay stored and dormant for that server invocation, and their later timers and hooks don't fire. `--resume` reports why it skipped them without blocking other runs. Restore the metadata from a backup or start a new session.

eve decides which runs to recover at startup. Hot reload doesn't recheck recovered runs against the latest workflow sources, so changing a workflow body while it runs can cause replay failure.

With the built-in local Workflow World, `eve dev` cancels unfinished runs whose snapshots are missing, at startup and after pruning. This includes waiting conversations and session timeout workflows. The reason goes in the run history without a terminal warning. Stopping `eve dev` doesn't cancel runs whose snapshots remain, but recovering them requires `--resume`.

`eve dev --resume`:

- Rejects custom Workflow Worlds, which don't use this cleanup and recovery policy.
- Refuses to attach to an already running local server.
- Recovers workflows, not the terminal transcript or a particular TUI conversation.

## `eve remote`

Use `eve remote` only with an explicit existing agent URL:

```bash
eve remote connect --url https://agent.example.com
eve remote connect --url https://agent.example.com --print "Summarize station telemetry"
eve remote info --url https://agent.example.com
```

Remote commands never start a local application.

### `eve remote connect`

```bash
eve remote connect --url <url> [--input <text>] [-H "Name: value"]
eve remote connect --url <url> --print <prompt> [-H "Name: value"]
```

Without `--print`, `connect` opens the interactive UI and requires a terminal. With `--print <prompt>`, it sends one message, writes only the final assistant text to stdout, and exits. It exits nonzero with an error on stderr if the turn fails, is cancelled, or needs input or authorization. It also fails if the stream ends before the turn finishes. The error includes the session ID once the server accepted the message. Each `--print` starts a new conversation and can't answer pending requests; use the `eve/client` API for that or for multi-turn scripts. `--input` pre-fills the interactive UI and can't be combined with `--print`.

Interactive `connect` accepts the same display flags as [`eve dev`](#eve-dev): `--show-tools`, `--show-reasoning`, `--show-subagents`, `--show-connection-auth`, `--assistant-response-stats`, `--context-size`, and `--logs`. The `--show-*` flags control rendering, not model reasoning effort. Set effort with `eve set model --reasoning <effort>` or `eve init --reasoning <effort>`.

Use `-H, --header <header>` for a bearer token or another request header; repeat it for multiple headers. For HTTP Basic authentication, put credentials in the URL; eve sends them as a Basic `Authorization` header and removes them from the target URL.

### `eve remote info`

```bash
eve remote info --url <url> [-H "Name: value"] [--json]
```

Verifies the existing agent and prints its inspection response. Use `-H, --header <header>` for protected targets; repeat it for multiple headers.

## `eve logs`

```bash
eve logs            # print the most recent diagnostic log
eve logs list          # list logs, most recent first
eve logs show <logid>  # print a specific log
eve logs --dump     # prepend the log's environment dump
eve logs --events   # interleave session events from the local workflow store
```

Each interactive `eve dev` process writes a private JSON Lines diagnostic log under `.eve/logs/`, whatever the transcript shows. It captures stderr, stdout (including sandbox and rebuild lines), tool failures, workflow errors, and eve framework log records. Each line is one JSON record with `at` and `source` fields.

A log id is the file name without `.log`, such as `dev-2026-07-15T12-00-00.000Z-123`. `eve logs show <logid>` also accepts the file name or the `.eve/logs/...` path printed in the dev transcript. It also accepts an unambiguous id prefix with or without `dev-`, so `eve logs 2026-07-15` works when one log matches. An ambiguous prefix fails and lists the candidates.

`eve logs` prints only records, with no path banner on either stream, so `eve logs 2>&1 | jq -c .` always parses. Find ids and paths with `eve logs list`; `--json` emits an array with `id`, `path`, `startedAt`, and `sizeBytes`.

`eve logs --events` reads session events (`session.started`, `turn.settled`, content deltas, …) from the local workflow store. It interleaves them by timestamp as `source: "event"` records. It selects events by the log's time window (its start through the next log's start), so events from concurrent `eve dev` processes can appear.

Each log has a `.dump` sibling with environment diagnostics and session stats as one JSON document. `eve logs --dump` prepends it to the log body, producing a JSON value stream (`eve logs --dump | jq -c .`) to attach to an issue. When a log has no dump, the flag does nothing.

## `eve traces`

```bash
eve traces list              # list traces, most recent first
eve traces list --json       # emit machine-readable trace summaries
eve traces show         # show the most recent span tree
eve traces show <trace> # show one span tree
eve traces --verbose       # expand every span with all attributes and events
eve traces --json          # dump the full trace as JSON
```

`eve traces` reads the trace store under `.eve/traces/v1`, so `eve dev` need not be running. It accepts a full trace id, a `gen_ai.conversation.id`, or an unambiguous prefix of either. Malformed trace files don't hide valid spans from the same trace.

Span rows show `↑input`/`↓output` token counts, gateway cost, and the tool name for `execute_tool` spans when recorded. The header lists the trace's models, sums token usage and cost from step spans, and counts error spans. `--json` prints the same records, one object per selected trace. `--verbose` expands each span with:

- Its status, error message, timing, and ids.
- Every attribute, with prompts, responses, and tool payloads shown as transcripts or pretty-printed JSON.
- Every span event, with its offset from span start.

Each root agent turn starts a new trace. With local caller trace context, the first turn of a local subagent joins the caller's trace as a child of the dispatch span. A remote child starts a separate root trace and links its first turn to the dispatch with `eve.link.type=agent.dispatch`. Later child turns start new traces. Related sessions share a `gen_ai.conversation.id`, and `agent.subagent.name` identifies the subagent. Pass the conversation ID to show all related traces, oldest first. A turn keeps one trace even when its worker is replaced.

Each workflow tool call has one `execute_tool <tool>` span. The first turn of each local session that the tool opens with `ctx.agent` is a child of that span. A remote session links to the span from its own trace. A `ctx.agent` call has no separate dispatch span; only agent execution uses `invoke_agent`.

Outbound MCP `tools/call` requests add MCP semantic attributes to the matching `execute_tool` span, or create a `CLIENT` `tools/call <tool>` span when there is none. Each `tools/list` discovery has a `CLIENT` span. eve injects configured OpenTelemetry propagation fields into MCP `params._meta`. It skips injection, and sends the request unchanged, when the JSON-RPC body exceeds 1 MiB or the propagation metadata exceeds 8 KiB. It removes its audience and session-lineage baggage before forwarding, and keeps the content-capture policy local.

A call through `eve__tool` or `eve__skill` is traced like a direct call to the entry it names. Its `execute_tool` span carries that entry's name and input, such as `execute_tool linear__list_issues`. A skill load has an `execute_tool eve:load-skill` span. The AI SDK's own tracing channel, which eve doesn't filter, still reports the `eve__tool` or `eve__skill` call.

A turn's root `invoke_agent` span is written when the turn ends, so a running turn shows only its steps.

Model, `execute_tool`, and memory spans retain their content by default. Set `EVE_TRACES_CONTENT=off` to omit system prompts, prompt messages, and response text for models; call arguments and results for tools; and recalled memory records. Each captured value is capped at 32 KB. When a model call's prompt messages exceed the cap, the oldest are dropped first and `agent.input.messages.omitted` records how many.

Step spans carry token counts under `agent.usage.*`, and cost when Vercel AI Gateway served the call. Model spans also expose `gen_ai.usage.*` counters. The CLI sums step-level counters only, so totals aren't counted twice.

### Retention

eve prunes the store as turns write traces, when a session finishes, and when the dev server starts. Pruning evicts the oldest traces past the bounds below. It keeps active traces, the newest traces, and anything written in the last five minutes, so the store can exceed its size budget. An open conversation doesn't pin its completed turns' traces. Set the bounds in `.env.local`, which `eve dev` loads automatically; each accepts `off`.

| Variable                     | Default              | Effect                                                                                            |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `EVE_TRACES`                 | on                   | `off` stops writing traces and stops pruning                                                      |
| `EVE_TRACES_CONTENT`         | on                   | `off` omits model prompt/response, tool input/output, and memory-record attributes on local spans |
| `EVE_TRACES_MAX_AGE_MS`      | `604800000` (7d)     | Age after which a trace may be evicted                                                            |
| `EVE_TRACES_MAX_TOTAL_BYTES` | `536870912` (512 MB) | Size budget for the whole store                                                                   |
| `EVE_TRACES_RETAIN_COUNT`    | `20`                 | Newest traces kept regardless of age or size                                                      |

## `eve link`

```bash
eve link
eve link --non-interactive --project <name-or-id> [--team <team-id-or-slug>]
```

Links the current directory to a Vercel project. After you select a team, create a project named for the agent or link an existing one. The picker shows recent projects; type a name and choose **Search for `'<name>'`** to search the rest of the team's projects. eve verifies the linked project ID, then pulls the project's environment so an AI Gateway credential (`VERCEL_OIDC_TOKEN` or `AI_GATEWAY_API_KEY`) lands in `.env.local`. Running it again re-links with fresh pickers.

For CI or an agent, pass `--non-interactive` and `--project`. Like `vercel link`, `--project` accepts a Vercel project name or ID, and `--team` accepts a team ID or slug. This mode never opens a picker or browser. A running `eve dev` reloads env files automatically after the pull.

## `eve deploy`

```bash
eve deploy
eve deploy --non-interactive --yes [--project <name-or-id>] [--team <team-id-or-slug>]
```

Deploys the agent to Vercel production (`vercel deploy --prod`), installing dependencies first and pulling environment variables after. A linked project deploys with or without a TTY. In a terminal, an unlinked project signs in to Vercel if needed and runs the `eve link` pickers.

For CI or an agent, pass `--non-interactive --yes`; `--yes` confirms the production deployment. `--project` links that Vercel project and pulls its environment before deploying, and `--team` works as in `eve link`. Without `--project`, the directory must already be linked. This mode never opens a picker, browser, or login flow.

## `eve eval`

```bash
eve eval [evalId...] [--url <url>] [options]
```

Runs the given evals, or all discovered evals when you omit ids. Ids match exactly or by directory prefix, so `eve eval weather` runs everything under `evals/weather/`.

| Exit code | Meaning                                                                  |
| --------- | ------------------------------------------------------------------------ |
| `0`       | Every eval passed                                                        |
| `1`       | An eval failed: a failed check, an execution error, or a `--strict` miss |
| `2`       | Configuration error                                                      |

Without `--url`, `eve eval` starts its own local server on a free port with state under `.eve/eval-servers/<run id>/`, removed after the run unless you pass `--keep-state`. A kept directory, including Workflow data in `.workflow-data/`, stays until a later `eve eval` in the same app cleans it up. The server runs beside an `eve dev` session for the same agent without touching it.

| Flag                     | Type   | Default | Description                                                    |
| ------------------------ | ------ | ------- | -------------------------------------------------------------- |
| `--url <url>`            | string | none    | Remote agent URL (skip local host startup)                     |
| `--tag <tag...>`         | string | none    | Run only evals carrying a tag                                  |
| `--exclude-tag <tag...>` | string | none    | Skip evals carrying a tag                                      |
| `--strict`               | flag   | off     | Below-threshold scores also fail the exit code                 |
| `--list`                 | flag   | off     | Print evals selected by the tag filters, without running them  |
| `--timeout <ms>`         | number | none    | Per-eval timeout in milliseconds                               |
| `--max-concurrency <n>`  | number | 8       | Max concurrent eval executions                                 |
| `--repeat <n>`           | number | 1       | Run every eval n times to measure repeatability                |
| `--json`                 | flag   | off     | Output results as JSON                                         |
| `--junit <path>`         | string | none    | Write JUnit XML results to a file                              |
| `--skip-report`          | flag   | off     | Skip eval-defined reporters (e.g. Braintrust)                  |
| `--keep-state`           | flag   | off     | Keep the local eval server's state after the run (not `--url`) |
| `--verbose`              | flag   | off     | Stream per-eval logs and workflow run IDs to stdout            |

See [Evals](../evals/overview) for authoring evals.

## Recommended loop

1. Edit files under `agent/`.
2. `eve info` to confirm discovery or read diagnostics.
3. `eve dev` while iterating locally.
4. `eve build` before shipping.
5. `eve start` to smoke-test the built output locally.

## What to read next

- [Agent Files](/docs/reference/agent-files): what `eve info` discovers
- [Instrumentation](../observability/instrumentation): tracing and the error catalog
- [Deployment](../guides/deployment/overview): `eve build` and `eve start` in production
