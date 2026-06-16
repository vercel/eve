---
title: "CLI"
description: "eve command reference: info, build, start, dev, eval."
---

The `eve` binary (`bin: eve`) runs from your app root, and every command loads `.env`/`.env.local` from that root before it does anything else.

## Commands

| Command                   | Does                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `eve info`                | Print the resolved application: discovered tools, skills, subagents, schedules, channels, routes, artifact paths, and discovery diagnostics |
| `eve build`               | Compile `.eve/` artifacts and build the host output; prints the output directory                                                            |
| `eve start`               | Serve the built `.output/` app; prints the listening URL                                                                                    |
| `eve dev`                 | Start the local dev server and open the terminal UI                                                                                         |
| `eve dev <url>`           | Connect the UI to an existing server URL (e.g. a remote deployment) instead of booting a local server                                       |
| `eve link`                | Link the directory to a Vercel project and pull AI Gateway credentials                                                                      |
| `eve deploy`              | Deploy the agent to Vercel production (links first if needed)                                                                               |
| `eve eval`                | Run evals against the local app or a remote target                                                                                          |
| `eve channels add [kind]` | Scaffold a channel interactively, or by kind (`slack` \| `web`)                                                                             |
| `eve channels list`       | List user-authored channels                                                                                                                 |

When `eve build` fails on discovery errors, it prints the full diagnostics report (severity, message, source path) and the diagnostics artifact path.

## `eve info`

```bash
eve info [--json]
```

| Flag     | Effect       |
| -------- | ------------ |
| `--json` | Emit as JSON |

When something behaves unexpectedly, run this first. It confirms a file was discovered, lists the active surface, and surfaces discovery diagnostics, all faster than booting the dev server.

## `eve build`

```bash
eve build
```

No flags. Compiles to `.eve/` and builds the host output, then prints the built output path.

Useful artifacts written under `.eve/` (preserved even on partial failure):

| Artifact                                       | Tells you                                            |
| ---------------------------------------------- | ---------------------------------------------------- |
| `.eve/discovery/agent-discovery-manifest.json` | What Eve found on disk                               |
| `.eve/discovery/diagnostics.json`              | Authored-shape errors and warnings                   |
| `.eve/compile/compiled-agent-manifest.json`    | The serialized authored surface Eve loads at runtime |
| `.eve/compile/compile-metadata.json`           | Build-time metadata and paths                        |
| `.eve/compile/module-map.mjs`                  | Compiled module entrypoints Eve imports at runtime   |

## `eve start`

```bash
eve start [--host <host>] [--port <port>]
```

| Flag            | Effect                                               |
| --------------- | ---------------------------------------------------- |
| `--host <host>` | Host interface to bind                               |
| `--port <port>` | Port to listen on (defaults to `$PORT`, then `3000`) |

Serves the previously built output. Prints the listening URL.

## `eve dev`

```bash
eve dev [options]
eve dev https://your-app.vercel.app
```

Pass a bare URL as the only argument and the UI connects to that server instead of booting a local one (same as `--url`). That's handy for smoke-testing a preview or production deployment. The interactive UI turns off in a non-TTY terminal.

| Flag                                | Effect                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `--host <host>`                     | Host interface to bind                                                                    |
| `--port <port>`                     | Port to listen on (defaults to `$PORT`, then `2000`)                                      |
| `-u, --url <url>`                   | Connect to an existing server URL instead of starting one                                 |
| `--no-ui`                           | Start the server without an interactive UI                                                |
| `--name <name>`                     | Title shown in the terminal UI (defaults to the app folder name)                          |
| `--input <text>`                    | Pre-fill the prompt input after launching the UI (editable; not auto-submitted)           |
| `--tools <mode>`                    | Tool-call rendering: `full` \| `collapsed` \| `auto-collapsed` \| `hidden`                |
| `--reasoning <mode>`                | Reasoning rendering: `full` \| `collapsed` \| `auto-collapsed` \| `hidden`                |
| `--subagents <mode>`                | Subagent-section rendering: `full` \| `collapsed` \| `auto-collapsed` \| `hidden`         |
| `--connection-auth <mode>`          | Connection-authorization rendering: `full` \| `collapsed` \| `auto-collapsed` \| `hidden` |
| `--assistant-response-stats <mode>` | Assistant header statistic: `tokens` \| `tokensPerSecond`                                 |
| `--context-size <tokens>`           | Model context window size, shown as a usage percentage                                    |
| `--logs <mode>`                     | Server/agent logs to show: `all` \| `stderr` \| `sandbox` \| `none`                       |

Local dev writes the active server process ID to `.eve/dev-process.pid`. If another `eve dev` starts for the same agent while that process is still running, Eve exits with a message that includes the command to stop the existing server.

Local dev keeps immutable runtime source snapshots under `.eve/dev-runtime/snapshots/` so in-flight sessions keep a consistent code revision while new prompts pick up rebuilds. `eve dev` prunes stale runtime snapshots and old local sandbox templates in the background on startup; stopping `eve dev` and deleting `.eve/dev-runtime/snapshots/` or `.eve/sandbox-cache/local/templates/` is safe when you want a manual cleanup.

## `eve link`

```bash
eve link
```

Links the current directory to an existing Vercel project by selecting a team and then a project, then pulls the project's environment so an AI Gateway credential (`VERCEL_OIDC_TOKEN` or `AI_GATEWAY_API_KEY`) lands in `.env.local`, and verifies one actually did. Running it again re-links: the pickers always run, and the new choice wins. Interactive only — in CI, use `vercel link --project <name> --yes` instead. A running `eve dev` reloads env files automatically, so no restart is needed after the pull.

## `eve deploy`

```bash
eve deploy
```

Deploys the agent to Vercel production (`vercel deploy --prod`), installing dependencies first and pulling environment variables after. An already-linked project deploys with or without a TTY (non-interactive runs pass the non-interactive `vercel` flags); an unlinked directory walks the `eve link` pickers when a terminal is present, and exits with guidance otherwise.

## `eve eval`

```bash
eve eval [evalId...] [--url <url>] [options]
```

Runs all discovered evals when no eval ids are given; ids match exactly or by directory prefix (`eve eval weather` runs everything under `evals/weather/`). Exits `0` when every eval passed its checks, `1` when any eval failed (a failed check, an execution error, or a `--strict` threshold miss), `2` on configuration errors.

| Flag                    | Effect                                         |
| ----------------------- | ---------------------------------------------- |
| `--url <url>`           | Remote agent URL (skip local host startup)     |
| `--tag <tag...>`        | Run only evals carrying a tag                  |
| `--strict`              | Below-threshold scores also fail the exit code |
| `--list`                | Print discovered evals without running them    |
| `--timeout <ms>`        | Per-eval timeout in milliseconds               |
| `--max-concurrency <n>` | Max concurrent eval executions (default 8)     |
| `--json`                | Output results as JSON                         |
| `--skip-report`         | Skip eval-defined reporters (e.g. Braintrust)  |

See [Evals](../evals/overview) for authoring evals.

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
