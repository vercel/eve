---
title: "CLI"
description: "Reference for every eve CLI command: init, info, build, start, dev, link, deploy, eval, and channels."
---

The `eve` binary (`bin: eve`) runs from your app root, and every command first loads `.env`/`.env.local` from that root. Running `eve` with no command runs `eve dev`.

## Commands

| Command                   | Description                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eve init [target]`       | Scaffold a new agent, or add one to an existing project directory                                                                                     |
| `eve info`                | Print the resolved application, including discovered tools, skills, subagents, schedules, channels, routes, artifact paths, and discovery diagnostics |
| `eve build`               | Compile `.eve/` artifacts and build the host output; prints the output directory                                                                      |
| `eve start`               | Serve the built `.output/` app; prints the listening URL                                                                                              |
| `eve dev`                 | Start the local dev server and open the terminal UI                                                                                                   |
| `eve dev <url>`           | Connect the UI to an existing server URL (e.g. a remote deployment) instead of booting a local server                                                 |
| `eve link`                | Link the directory to a Vercel project and pull AI Gateway credentials                                                                                |
| `eve deploy`              | Deploy the agent to Vercel production (links first if needed)                                                                                         |
| `eve eval`                | Run evals against the local app or a remote target                                                                                                    |
| `eve channels add [kind]` | Scaffold a channel interactively, or by kind (`slack` \| `web`)                                                                                       |
| `eve channels list`       | List user-authored channels                                                                                                                           |

When `eve build` fails on discovery errors, it prints the full diagnostics report (severity, message, source path) and the diagnostics artifact path.

## `eve init`

```bash
eve init [target] [--channel-web-nextjs]
```

The optional `target` decides the mode:

- A name (`eve init my-agent`) scaffolds a fresh project in a new `my-agent/` directory.
- An existing directory, including `.` for the current one (`eve init .`), adds an agent to that project. The project needs a `package.json`, the `agent/` files must not exist yet, and the missing `eve`, `ai`, and `zod` dependencies are added without touching anything else.
- Omitting the target scaffolds or updates the current directory, the same as `eve init .`. The exception is a coding agent (Claude Code, Cursor, and the like): running `eve init` with no target prints a setup guide instead of scaffolding, since a bare invocation means the agent has not chosen what to build yet.

Both scaffold modes install dependencies. A fresh project initializes Git; an existing project keeps its repository and scripts. On an interactive human terminal, when a supported coding-agent CLI (`claude`, `codex`, `cursor-agent`, `droid`, `gemini`, `opencode`, or `pi`) is on `PATH`, `eve init` offers the available REPLs and `eve dev` (the default). Each REPL receives a project-specific prompt that guides the user through building the agent. It also explains that bare `eve dev` starts HMR and the agent's terminal REPL, while `eve dev --no-ui` is the controllable verification path. Without any of those executables, human invocations run `eve dev` through the detected project package manager. Fresh projects inherit a parent workspace manager when one is present; otherwise they use the manager that launched `eve init`. Coding-agent invocations print the same project-specific handoff, and the agent can run that command with `--no-ui` for headless verification.

| Flag                   | Type | Default | Description                                                                                                                            |
| ---------------------- | ---- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--channel-web-nextjs` | flag | off     | Add the Web Chat application (a Next.js app). Rejected when adding to an existing project; run `eve channels add web` there afterward. |

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
eve build
```

No flags. Compiles to `.eve/` and builds the host output, then prints the built output path.

Useful artifacts written under `.eve/` (preserved even on partial failure):

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

Pass a bare URL as the only argument and the UI connects to that server instead of booting a local one (same as `--url`), which lets you smoke-test a preview or production deployment. The interactive UI turns off in a non-TTY terminal.

| Flag                                | Type   | Default            | Description                                                                               |
| ----------------------------------- | ------ | ------------------ | ----------------------------------------------------------------------------------------- |
| `--host <host>`                     | string | all interfaces     | Host interface to bind                                                                    |
| `--port <port>`                     | number | `$PORT`, then 3000 | Port to listen on                                                                         |
| `-u, --url <url>`                   | string | none               | Connect to an existing server URL instead of starting one                                 |
| `--no-ui`                           | flag   | UI on              | Start the server without an interactive UI                                                |
| `--name <name>`                     | string | app folder name    | Title shown in the terminal UI                                                            |
| `--input <text>`                    | string | none               | Pre-fill the prompt input after launching the UI (editable, not auto-submitted)           |
| `--tools <mode>`                    | enum   | `auto-collapsed`   | Tool-call rendering: `full` \| `collapsed` \| `auto-collapsed` \| `hidden`                |
| `--reasoning <mode>`                | enum   | `full`             | Reasoning rendering: `full` \| `collapsed` \| `auto-collapsed` \| `hidden`                |
| `--subagents <mode>`                | enum   | `auto-collapsed`   | Subagent-section rendering: `full` \| `collapsed` \| `auto-collapsed` \| `hidden`         |
| `--connection-auth <mode>`          | enum   | `full`             | Connection-authorization rendering: `full` \| `collapsed` \| `auto-collapsed` \| `hidden` |
| `--assistant-response-stats <mode>` | enum   | `tokensPerSecond`  | Assistant header statistic: `tokens` \| `tokensPerSecond`                                 |
| `--context-size <tokens>`           | number | none               | Model context window size, shown as a usage percentage                                    |
| `--logs <mode>`                     | enum   | `stderr`           | Server/agent logs to show: `all` \| `stderr` \| `sandbox` \| `none`                       |

Local dev records the last ready URL per resolved app root in `.eve/dev-server-state.v1.json`. A second interactive `eve dev` reconnects only when that URL is loopback and healthy; each terminal UI creates a fresh client session while sharing the server process. A stale or malformed record is replaced when eve starts a new server. Passing `--host`, `--port`, or a `PORT` environment value skips reconnection and reports a healthy recorded server instead.

Local dev keeps immutable runtime source snapshots under `.eve/dev-runtime/snapshots/` so in-flight sessions hold a consistent code revision while new prompts pick up rebuilds. On startup, `eve dev` prunes stale runtime snapshots and old local sandbox templates in the background. For manual cleanup, stop `eve dev` and delete `.eve/dev-runtime/snapshots/` or `.eve/sandbox-cache/local/templates/`.

## `eve link`

```bash
eve link
```

Links the current directory to an existing Vercel project. You select a team and then one of its recent projects; type a project name and choose **Search for '<name>'** to search the rest of that team's projects. Vercel links the selected project, eve verifies its project ID, and then pulls the project's environment so an AI Gateway credential (`VERCEL_OIDC_TOKEN` or `AI_GATEWAY_API_KEY`) lands in `.env.local`. Running it again re-links: the pickers always run, and the new choice wins. The command is interactive only; in CI, use `vercel link --project <name> --yes --non-interactive` instead. A running `eve dev` reloads env files automatically, so you don't need to restart after the pull.

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
