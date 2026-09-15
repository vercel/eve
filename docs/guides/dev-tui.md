---
title: "Terminal UI"
description: "Use eve locally or connect to a deployed agent from an interactive terminal UI."
---

`eve dev` starts a local development server and opens an interactive terminal UI. Use it to talk to your agent, approve tool calls, answer its questions, and configure local development.

```bash
eve dev
```

The transcript remains in your terminal scrollback after you exit. Run `/help` in the UI to see the commands available in the current session.

## Commands

| Command     | Description                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/login`    | Connect a ChatGPT subscription, Vercel account, or provider API key.                                                                                         |
| `/model`    | Choose the model and its settings. Pass a model ID to set it directly: `/model provider/model-id`.                                                           |
| `/add`      | Select and install channels, MCP connections, extensions, and observability integrations. Pass an item address to install it directly: `/add channel/slack`. |
| `/deploy`   | Deploy the agent to Vercel production. Installs the Vercel CLI, signs in, and links the directory if needed.                                                 |
| `/info`     | Show the resolved application, compiled artifacts, discovery diagnostics, and messaging routes.                                                              |
| `/loglevel` | Choose which server and agent logs appear in the transcript.                                                                                                 |
| `/traces`   | Open the local trace viewer. Pass a trace ID prefix to open a specific trace.                                                                                |
| `/reset`    | Start a fresh session.                                                                                                                                       |
| `/cancel`   | Cancel the current turn without discarding settled context.                                                                                                  |
| `/clear`    | Clear the session's model-message history. `/new` is an alias.                                                                                               |
| `/compact`  | Compact the current session's context.                                                                                                                       |
| `/exit`     | Quit the UI.                                                                                                                                                 |
| `/help`     | List available commands.                                                                                                                                     |

`/login`, `/model`, `/add`, `/deploy`, `/info`, and `/traces` are available when `eve dev` runs locally. They are unavailable when the UI connects to a server with `--url`.

## Set up a new agent

After interactive `eve init`, the TUI opens directly. eve keeps the project's selected connection. For a new connection, it checks explicit environment credentials, the saved machine default, and then the Vercel CLI's current team. Existing project OIDC connections remain supported. Automatic Vercel reuse validates account access without creating or linking a project.

During startup, the composer stays visible while a progress indicator names the connection being checked and shows when eve is preparing your chat. Type a message and press `Enter` to queue it for when the agent is ready. A picker temporarily takes over input when a choice or API key is needed; your draft returns afterward. If setup is cancelled or fails, queued messages return to the draft.

If no connection is ready, `/login` offers:

1. Vercel Account
2. Vercel AI Gateway API Key
3. ChatGPT Subscription
4. OpenAI API Key
5. Anthropic API Key

Vercel account login opens a browser. eve reuses the current CLI team when valid, selects a sole available team automatically, or shows a searchable team picker. Account-token access to Gateway depends on availability for your account and team; if it is unavailable, choose an API key or another connection.

Type to filter a menu, press `Enter` to select, or `Esc` to return to chat. Dismissing a setup menu adds no cancellation message to the transcript; completed work and failures still appear. Arrow navigation is also available. Cancelling login preserves your draft. If a connection fails, retry `/login`; eve does not silently switch providers.

### Credentials and deployment

eve saves API keys and eve-owned OAuth refresh credentials in the OS secret store through just-secrets. It saves the last successful login as the machine default and records the project's connection and team separately as nonsecret metadata in `.eve/provider.json`. Newly entered keys are never written into project files. A key explicitly selected through `/login` takes precedence over another key for that provider in your shell; a project connected through environment credentials continues to use its environment. Vercel CLI retains ownership of its credentials and refresh tokens.

Local discovery runs only in development. Deployments need explicitly provisioned `AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or supported project OIDC credentials. ChatGPT subscription models are local-only. `/login` does not link a deployment or authenticate a remote server; `/deploy` handles Vercel CLI installation and account login when needed.

### Models and settings

`/model` opens the model picker and settings. Each completed selection applies immediately and returns to chat; there is no final Done step. A successful login or model change takes effect on the next prompt.

OpenAI, ChatGPT, and Gateway connections default to `gpt-5.6-luna-fast`; Anthropic defaults to `claude-sonnet-5`. An explicitly authored compatible model stays selected. If a new default is unavailable, eve offers the connection's available models. Dynamic or custom model expressions must be edited in `agent.ts`.

## Add an integration

`/add` opens one searchable catalog of channels, connections, extensions, and integrations. Type to filter and press `Enter` to install one item and run its required setup. The flow returns to chat afterward.

Pass an item address to install it directly:

```text
/add channel/slack
/add extension/agent-browser
/add channel/linear
/add @acme/analytics
```

Required authorization or deployment setup still runs for the selected item. Press `Esc` to cancel setup; files already installed remain in the project.

## Work with the agent

Type a message and press `Enter` to send it. When the agent asks a question or requests tool approval, respond in the prompt shown by the UI. Connection authorization can open a browser; keep local `eve dev` running until the browser returns to it.

While a turn is running, `Enter` queues a follow-up message. Press `Esc` or `Ctrl+C` to cancel the turn; when messages are queued, this uses the oldest queued message as the next turn instead. If a direct cancellation requested with `/cancel` or `Ctrl+C` does not settle, press `Ctrl+C` to stop waiting. The UI then returns to the prompt and asks you to press `Ctrl+C` again to exit. At an idle prompt, press `Ctrl+C` twice to exit.

| Key           | Action                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Enter`       | Send the current message or answer.                                                                                     |
| `Shift+Enter` | Insert a newline. Requires a terminal that reports modified keys.                                                       |
| `Esc`         | Cancel a running turn, or steer with the oldest queued message.                                                         |
| `Ctrl+C`      | Cancel or steer during a turn; stop a pending cancellation, then exit on the next press; press twice to exit when idle. |
| `↑` / `↓`     | Move through input lines or sent-message history.                                                                       |
| `Ctrl+L`      | Cycle log display modes.                                                                                                |
| `Ctrl+R`      | Redraw the screen.                                                                                                      |

## Logs and traces

By default, the UI shows `stderr` logs. Use `/loglevel <all|stderr|sandbox|none>` to change the display; bare `/loglevel` reports the current setting. `Ctrl+L` cycles the same modes.

Every `eve dev` process writes diagnostic logs to `.eve/logs/`, regardless of the display mode. Read them with [`eve logs`](../reference/cli#eve-logs).

Use `/traces` to inspect traces recorded during local development. See [Instrumentation](instrumentation#local-traces) for trace capture and retention settings.

## Display options

Use `eve dev` flags to control tool calls, reasoning, subagents, connection authorization, response statistics, context usage, and logs:

```bash
eve dev --tools full --reasoning collapsed --logs all
```

Use `--host` and `--port` to bind the local server, or `--no-ui` to run without the terminal UI. See the [`eve dev` CLI reference](../reference/cli#eve-dev) for the complete option list, accepted values, and defaults.

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

Remote Vercel sessions reuse an existing authorized CLI session. They do not open an account login flow or modify the local project's Vercel link or `.env.local`. If deployment protection blocks access, provide `VERCEL_AUTOMATION_BYPASS_SECRET` or configure access in the target project's Deployment Protection settings.

## What to read next

- [Instrumentation](./instrumentation): traces, OpenTelemetry, and diagnostics.
- [CLI](../reference/cli): commands and flags.
- [Agent Client Protocol (ACP)](../protocols/acp): drive the same agent from ACP clients such as Zed instead of the TUI.
