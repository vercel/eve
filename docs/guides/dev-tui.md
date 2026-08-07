---
title: "Dev TUI"
description: "Use eve locally or connect to a deployed agent from an interactive terminal UI."
---

`eve dev` starts a local development server and opens an interactive terminal UI. Use it to talk to your agent, approve tool calls, answer its questions, and configure local development.

```bash
eve dev
```

The transcript remains in your terminal scrollback after you exit. Run `/help` in the UI to see the commands available in the current session.

## Commands

| Command       | Description                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `/model`      | Configure the model and its provider. Pass a model ID to set it directly: `/model provider/model-id`. |
| `/add`        | Browse and install channels, MCP connections, extensions, and observability integrations.             |
| `/deploy`     | Deploy the agent to Vercel production. Links the directory first if needed.                           |
| `/vc:install` | Install the Vercel CLI.                                                                               |
| `/vc:login`   | Log in to Vercel or restore access to a remote deployment.                                            |
| `/loglevel`   | Choose which server and agent logs appear in the transcript.                                          |
| `/traces`     | Open the local trace viewer. Pass a trace ID prefix to open a specific trace.                         |
| `/reset`      | Start a fresh session.                                                                                |
| `/cancel`     | Cancel the current turn without discarding settled context.                                           |
| `/clear`      | Clear the session's model-message history. `/new` is an alias.                                        |
| `/compact`    | Compact the current session's context.                                                                |
| `/exit`       | Quit the UI.                                                                                          |
| `/help`       | List available commands.                                                                              |

`/model`, `/add`, `/deploy`, and `/traces` are available when `eve dev` runs locally. They are unavailable when the UI connects to a server with `--url`.

## Work with the agent

Type a message and press `Enter` to send it. When the agent asks a question or requests tool approval, respond in the prompt shown by the UI. Connection authorization can open a browser; keep local `eve dev` running until the browser returns to it.

While a turn is running, `Enter` queues a follow-up message. Press `Esc` or `Ctrl+C` to cancel the turn; when messages are queued, this uses the oldest queued message as the next turn instead. At an idle prompt, press `Ctrl+C` twice to exit.

| Key           | Action                                                                              |
| ------------- | ----------------------------------------------------------------------------------- |
| `Enter`       | Send the current message or answer.                                                 |
| `Shift+Enter` | Insert a newline. Requires a terminal that reports modified keys.                   |
| `Esc`         | Cancel a running turn, or steer with the oldest queued message.                     |
| `Ctrl+C`      | Cancel or steer during a turn; clear input, then exit on a second press, when idle. |
| `↑` / `↓`     | Move through input lines or sent-message history.                                   |
| `Ctrl+L`      | Cycle log display modes.                                                            |
| `Ctrl+R`      | Redraw the screen.                                                                  |

## Logs and traces

By default, the UI shows `stderr` logs. Use `/loglevel <all|stderr|sandbox|none>` to change the display; bare `/loglevel` reports the current setting. `Ctrl+L` cycles the same modes.

Every `eve dev` process writes diagnostic logs to `.eve/logs/`, regardless of the display mode. Read them with [`eve logs`](../reference/cli#eve-logs).

Use `/traces` to inspect traces recorded during local development. See [Instrumentation](instrumentation#local-traces) for trace capture and retention settings.

## Display options

Use `eve dev` flags to control how much detail the UI renders:

```bash
eve dev --tools full --reasoning collapsed --logs all
```

| Flag                         | Values                                          | Description                                        |
| ---------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| `--tools`                    | `full`, `collapsed`, `auto-collapsed`, `hidden` | Tool-call display.                                 |
| `--reasoning`                | `full`, `collapsed`, `auto-collapsed`, `hidden` | Reasoning display.                                 |
| `--subagents`                | `full`, `collapsed`, `auto-collapsed`, `hidden` | Subagent display.                                  |
| `--connection-auth`          | `full`, `collapsed`, `auto-collapsed`, `hidden` | Connection-authorization display.                  |
| `--assistant-response-stats` | `tokens`, `tokensPerSecond`                     | Assistant response statistic.                      |
| `--context-size`             | Token count                                     | Model context-window size for the usage indicator. |
| `--logs`                     | `all`, `stderr`, `sandbox`, `none`              | Initial log display mode.                          |

Use `--host` and `--port` to bind the local server, or `--no-ui` to run without the terminal UI. See the [CLI reference](../reference/cli#eve-dev) for all options.

## Connect to a deployment

Pass a URL to use the terminal UI with an existing eve server instead of starting one locally:

```bash
eve dev https://your-app.vercel.app
```

The URL form is shorthand for `--url`. To send credentials or custom request headers, use a URL with HTTP Basic credentials or repeat `-H, --header`:

```bash
eve dev https://user:pass@your-app.example.com
eve dev https://your-app.example.com -H 'Authorization: Bearer your_token_here'
```

For a Vercel deployment that needs authentication, run `/vc:login` and follow the prompt. Remote sessions do not modify the local project's Vercel link or `.env.local`.

## What to read next

- [Instrumentation](./instrumentation): traces, OpenTelemetry, and diagnostics.
- [CLI](../reference/cli): commands and flags.
