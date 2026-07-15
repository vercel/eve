---
title: "CLI"
description: "Reference for every eve CLI command: init, info, build, start, dev, link, deploy, eval, channels, and extension."
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
| `eve link`                    | Link the directory to a Vercel project and pull AI Gateway credentials                                                                                |
| `eve deploy`                  | Deploy the agent to Vercel production (links first if needed)                                                                                         |
| `eve eval`                    | Run evals against the local app or a remote target                                                                                                    |
| `eve channels add [kind]`     | Scaffold a channel interactively, or by kind (`slack` \| `web`)                                                                                       |
| `eve channels list`           | List user-authored channels                                                                                                                           |
| `eve extension init [target]` | Create a new extension package                                                                                                                        |
| `eve extension build`         | Build the current package as an extension                                                                                                             |

When `eve build` fails on discovery errors, it prints the full diagnostics report (severity, message, source path) and the diagnostics artifact path.

## `eve init`

```bash
eve init [target] [--channel-web-nextjs]
```

Creates a new agent app or adds an agent to an existing app. Always installs dependencies. New directories also initialize Git.

| Target                                    | What happens                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eve init my-agent`                       | New agent project in `my-agent/`                                                                                                                         |
| `eve init .` (or an existing project dir) | Adds `agent/` plus missing `eve`, `ai`, and `zod` deps. Needs a `package.json` and no `agent/` files yet                                                 |
| `eve init` with no target                 | Same as `eve init .`, except coding agents (Claude Code, Cursor, and similar) get a setup guide instead of scaffolding — they have not chosen a name yet |

After scaffolding, a human terminal usually continues into `eve dev` (or a coding-agent REPL if one is on `PATH` and you pick it). Coding-agent launches print the next steps instead of opening the TUI, so the session does not get stuck. Fresh projects use the parent workspace's package manager when there is one; otherwise they use the manager that launched `eve init`.

| Flag                   | Type | Default | Description                                                                                           |
| ---------------------- | ---- | ------- | ----------------------------------------------------------------------------------------------------- |
| `--channel-web-nextjs` | flag | off     | Add the Web Chat app (Next.js). Not for existing projects — run `eve channels add web` there instead. |

## `eve extension`

Commands for reusable [extension](/docs/extensions) packages. An extension is identified by `package.json#eve.extension` (for example `"eve": { "extension": "./extension" }`).

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

Builds the current package as an extension: compiles the mount factory and tool re-exports into `dist/`, and fills the package `exports` map. Requires `package.json#eve.extension`.

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
| `--port <port>`                     | number | `$PORT`, then 3000 | Port to listen on                                                                         |
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

A fresh `eve init` passes `--input /model`. That bare local input starts onboarding: the TUI installs the Vercel CLI if needed, asks you to log in if needed, then opens `/model`. Other input stays editable in the prompt.

For a URL target protected by HTTP Basic auth, put the credentials in the URL. Eve sends them as a Basic `Authorization` header and strips them from the server URL before connecting:

```bash
eve dev https://user:pass@your-app.example.com
```

For bearer tokens or custom schemes, pass explicit headers with `-H`.

Local dev records the last ready URL per resolved app root in `.eve/dev-server-state.v1.json`. A second interactive `eve dev` reconnects only when that URL is loopback and healthy; each terminal UI creates a fresh client session while sharing the server process. A stale or malformed record is replaced when eve starts a new server. Passing `--host`, `--port`, or a `PORT` environment value skips reconnection and reports a healthy recorded server instead.

Local dev keeps immutable runtime source snapshots under `.eve/dev-runtime/snapshots/` so in-flight turns hold a consistent code revision while new turns pick up rebuilds. The terminal REPL keeps its logical session across successful rebuilds, so the next turn continues the conversation on the latest generation; use `/new` to start a fresh session. After a generation is superseded, `eve dev` retains it for at least 30 minutes and also retains the five most recently superseded generations, regardless of the configured Workflow World. The active generation is never pruned. Old runtime snapshots and local sandbox templates are pruned in the background. For manual cleanup, stop `eve dev` before deleting `.eve/dev-runtime/snapshots/` or `.eve/sandbox-cache/local/templates/`. A turn that remains unfinished beyond the automatic retention window can no longer resume after its generation is pruned.

## `eve link`

```bash
eve link
```

Links the current directory to a Vercel project. After selecting a team, you can create a project named for the agent or link an existing project. The existing-project picker shows recent projects; type a project name and choose **Search for '<name>'** to search the rest of that team's projects. Vercel links the resolved project, eve verifies its project ID, and then pulls the project's environment so an AI Gateway credential (`VERCEL_OIDC_TOKEN` or `AI_GATEWAY_API_KEY`) lands in `.env.local`. Running it again re-links: the pickers always run, and the new choice wins. The command is interactive only; in CI, use `vercel link --project <name> --yes --non-interactive` instead. A running `eve dev` reloads env files automatically, so you don't need to restart after the pull.

## `eve deploy`

```bash
eve deploy
```

Deploys the agent to Vercel production (`vercel deploy --prod`), installing dependencies first and pulling environment variables after. An already-linked project deploys with or without a TTY (non-interactive runs pass the non-interactive `vercel` flags). An unlinked directory walks the `eve link` pickers when a terminal is present, and exits with guidance otherwise.

## `eve eval`

```bash
eve eval [evalId...] [--url <url>] [options]
```

Runs all discovered evals when no eval ids are given; ids match exactly or by directory prefix (`eve eval weather` runs everything under `evals/weather/`). Exits `0` when every eval passed its checks, `1` when any eval failed (a failed check, an execution error, or a `--strict` threshold miss), `2` on configuration errors.

| Flag                    | Type   | Default | Description                                    |
| ----------------------- | ------ | ------- | ---------------------------------------------- |
| `--url <url>`           | string | none    | Remote agent URL (skip local host startup)     |
| `--tag <tag...>`        | string | none    | Run only evals carrying a tag                  |
| `--strict`              | flag   | off     | Below-threshold scores also fail the exit code |
| `--list`                | flag   | off     | Print discovered evals without running them    |
| `--timeout <ms>`        | number | none    | Per-eval timeout in milliseconds               |
| `--max-concurrency <n>` | number | 8       | Max concurrent eval executions                 |
| `--json`                | flag   | off     | Output results as JSON                         |
| `--junit <path>`        | string | none    | Write JUnit XML results to a file              |
| `--skip-report`         | flag   | off     | Skip eval-defined reporters (e.g. Braintrust)  |
| `--verbose`             | flag   | off     | Stream per-eval `t.log` lines to stdout        |

See [Evals](../evals/overview) for authoring evals.

## `eve channels add`

```bash
eve channels add [kind] [-f] [-y]
```

Scaffolds a channel into `agent/channels/`. With no `kind` it prompts interactively; pass a `kind` (`slack` \| `web`) to scaffold one directly.

| Flag          | Type | Default | Description                                               |
| ------------- | ---- | ------- | --------------------------------------------------------- |
| `-f, --force` | flag | off     | Overwrite existing channel files                          |
| `-y, --yes`   | flag | off     | Assume yes for confirmations; requires an explicit `kind` |

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
- [Deployment](../guides/deployment): `eve build` and `eve start` in production
