---
title: "Terminal UI"
description: "Use eve locally or connect to a deployed agent from an interactive terminal UI."
---

`eve dev` starts a local development server and opens an interactive terminal UI. In the UI, you talk to your agent, approve tool calls, answer its questions, and configure local development. Self-modification is on by default in a local server; see [Self-Modification](./self-modification).

```bash
eve dev
```

The footer shows the active model, reasoning level when set, speed indicator, and connection, such as `gpt-6-luna · high · ⚡︎`. The model label drops the provider prefix and a trailing `-fast`; `⚡︎` marks a `-fast` model or **Fast** mode. A Vercel account connection shows the team slug once it resolves.

The transcript stays in your terminal scrollback after you exit. Before your first message, the empty composer may suggest a change to ask your agent for; typing replaces the suggestion.

## Commands

| Command     | Description                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/model`    | Choose the model, speed, and reasoning. Pass a model ID to set it directly: `/model provider/model-id`.                                                      |
| `/new`      | Start a fresh session and clear the screen. `/reset` is an alias.                                                                                            |
| `/clear`    | Cancel the running turn and every working task, then clear the session's model-message history and keep the session.                                         |
| `/compact`  | Compact the current session's context.                                                                                                                       |
| `/cancel`   | Cancel the current turn and keep the context from work that already finished.                                                                                |
| `/login`    | Connect a ChatGPT subscription, Vercel account, or provider API key.                                                                                         |
| `/add`      | Select and install channels, MCP connections, extensions, and observability integrations. Pass an item address to install it directly: `/add channel/slack`. |
| `/deploy`   | Deploy the agent to Vercel production. Installs the Vercel CLI, signs in, and links the directory if needed.                                                 |
| `/traces`   | Open the local trace viewer. Pass a trace ID prefix to open a specific trace.                                                                                |
| `/loglevel` | Choose which server and agent logs appear in the transcript.                                                                                                 |
| `/info`     | Show the resolved application, compiled artifacts, discovery diagnostics, and messaging routes.                                                              |
| `/help`     | List available commands.                                                                                                                                     |
| `/exit`     | Quit the UI.                                                                                                                                                 |

`/login`, `/model`, `/add`, `/deploy`, `/info`, and `/traces` work only in local `eve dev`, not through `eve remote connect`.

A [stranded session](./deployment/self-hosted-operations#recover-a-stranded-session) accepts no new messages or approvals. When a message or a stream reconnect reaches one, the TUI says why and, when known, which eve version built it. Run `/new` to end it; your next message starts a fresh session. `/clear` is refused because it would keep the stranded session. A message accepted before the upgrade is not redelivered. A session from an earlier `eve dev` process built by the same eve version is not stranded; see [local workflow recovery](../reference/cli#local-workflow-recovery).

## Set up a new agent

After interactive `eve init`, the TUI opens directly. eve keeps the connection already selected for the project, including a project OIDC connection. Without one, it checks credentials set in the environment, the saved machine default, and then the Vercel CLI's current team. With the Vercel CLI team, eve checks account access but doesn't create or link a Vercel project.

During startup, a progress indicator names the connection being checked. Messages you send before the agent is ready are queued. A picker takes over input when a choice or API key is needed, then your draft returns. If setup is cancelled or fails, queued messages return to the draft.

If no connection is ready, `/login` offers:

1. Vercel Account
2. Vercel AI Gateway API Key
3. ChatGPT Subscription
4. OpenAI API Key
5. Anthropic API Key

Vercel account login opens a browser. With several teams, `/login` shows a searchable team picker with the current project or CLI team highlighted; a sole team is selected automatically. Account-token access to Gateway depends on your account and team; if it is unavailable, choose an API key or another connection.

In a menu, type to filter, use the arrow keys, press `Enter` to select, or press `Esc` to return to chat. Cancelling login preserves your draft. If a connection fails, retry `/login`; eve does not switch providers on its own.

### Credentials and deployment

eve saves API keys and its OAuth refresh credentials in the OS secret store, never in project files. The last successful login becomes the machine default. eve records the project's connection and team, which aren't secret, in `.eve/provider.json`. A key selected through `/login` takes precedence over the same provider's key in your shell. A project connected through environment credentials keeps using its environment. The Vercel CLI keeps its own credentials.

Credential discovery runs only in local development. Deployments need `AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or project OIDC credentials. ChatGPT subscription models are local-only. `/login` doesn't link a deployment or authenticate a remote server; `/deploy` installs the Vercel CLI and signs you in when needed.

### Models and settings

`/model` walks through model, speed, and reasoning in order:

1. Choose a model. Type to filter the list.
2. Choose **Standard** or **Fast** speed, when supported.
3. Choose a reasoning level, when the model supports reasoning settings. **Provider default** leaves the reasoning level to the provider.

The picker highlights your compatible current settings and skips settings that can't change. `Enter` advances, `Esc` or `←` goes back a step or cancels at the model list, and `Ctrl+C` cancels from any step. Changes apply together after the final choice; cancelling changes nothing. A login or model change takes effect on the next prompt.

Gateway connections default to `openai/gpt-6-luna-fast`, OpenAI and ChatGPT to `gpt-6-luna-fast`, and Anthropic to `claude-sonnet-5`. An authored compatible model stays selected. If the default is unavailable, eve offers the connection's available models. Edit dynamic or custom model expressions in `agent.ts`.

## Add an integration

`/add` opens a searchable catalog of channels, connections, extensions, and integrations. Press `Enter` to install an item and run its setup, then return to chat.

Pass an item address to install it directly:

```text
/add channel/slack
/add extension/agent-browser
/add channel/linear
/add @acme/analytics
```

Press `Esc` to cancel setup; files already installed stay in the project. If dependency installation fails, rerun the `eve add` command in a terminal to see the installer output.

## Work with the agent

Type a message and press `Enter` to send it. Answer questions and tool approvals in the prompt the UI shows; each answer is sent as soon as you give it. With several open requests, the prompt shows its position, such as `2 of 5`, and names the task that asked. Connection authorization can open a browser; keep local `eve dev` running until the browser returns to it.

The activity line shows elapsed time and token counts when available, with one of these states:

- **Thinking**: the model reasons or waits.
- **Generating**: the model writes a response or tool input.
- **Running**: tools execute. While [tasks](../tools/tasks) work, the task drawer header replaces this line with the parent's activity, task count, and turn time. **Waiting** means the parent is waiting on tasks; **Working** means tasks remain active between turns.

A tool call shows the tool's `label`, or eve's text for a built-in tool, such as `Read README.md`. Other tools show a readable name without the extension or connection prefix, such as `List issues` for `linear__list_issues`. Approval prompts use the same name, such as `Approve Linear: List issues?`.

A task, such as a subagent call, writes one transcript line when it starts and one when it finishes, fails, or is stopped. The finished line shows the duration and, for a subagent, what it did, such as `Read 3 files, Ran 2 commands`.

While tasks work, a drawer above the prompt shows each task's name, latest tool, and elapsed time. Subagents get readable labels, such as `subagent(stock price)` for `stock-price` or `subagent(worker)` for the code extension's `code__worker`. Work started by a subagent appears beneath it. The drawer caps its height, puts tasks awaiting approval first, and yields to questions and approvals on small terminals. The model's `eve__task_wait` and `eve__task_cancel` calls appear only as the **Waiting** header and a stopped task's line.

The prompt stays open while the agent works, including turns started elsewhere, such as a scheduled run. Pressing `Enter` during a turn sends your message as steering, which adds it to the running turn:

- Before the agent starts writing its reply, steering stops the model and continues the turn with your message. Running tools finish first.
- After the reply starts, the streamed text stays, and your message joins the turn at its next step. See [Message delivery and steering](../concepts/execution-model-and-durability#message-delivery-and-steering).

Slash commands run immediately, even during a turn. Press `Esc` or `Ctrl+C`, or run `/cancel`, to cancel a running turn. A cancel sent before the turn starts applies only to that turn, never to a later one. If the cancel doesn't finish, press `Ctrl+C` again to stop waiting and start a new session; the next `Ctrl+C` exits. At an idle prompt, press `Ctrl+C` twice to exit.

| Key           | Action                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `Enter`       | Send the current message or answer.                                                                        |
| `Shift+Enter` | Insert a newline. Requires a terminal that reports modified keys.                                          |
| `Esc`         | Cancel a running turn.                                                                                     |
| `Ctrl+C`      | Cancel a running turn; press again to stop waiting and start a new session; press twice to exit when idle. |
| `↑` / `↓`     | Move through input lines or sent-message history.                                                          |
| `Ctrl+L`      | Cycle log display modes.                                                                                   |
| `Ctrl+R`      | Redraw the screen.                                                                                         |

## Logs and traces

The UI shows severity-tagged errors by default. Run `/loglevel <mode>` or press `Ctrl+L` to change the display; bare `/loglevel` reports the current mode.

| Mode    | Shows                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------- |
| `none`  | No logs.                                                                                                              |
| `error` | Errors (default).                                                                                                     |
| `warn`  | Errors and warnings.                                                                                                  |
| `debug` | All severity-tagged records.                                                                                          |
| `all`   | Also unclassified stdout, stderr, sandbox output, and Workflow SDK lines such as `[workflow-sdk]` or `[world-local]`. |

These modes filter the display only; they don't change `EVE_LOG_LEVEL` or a dependency's debug logging. Every `eve dev` process writes diagnostic logs to `.eve/logs/` regardless of mode. Read them with [`eve logs`](../reference/cli#eve-logs).

Use `/traces` to inspect traces recorded during local development. See [Local traces](../observability/otel#local-traces) for trace capture and retention settings.

## Display options

`eve dev` flags control how tool calls, reasoning, subagents, connection authorization, response statistics, context usage, and logs display:

```bash
eve dev --show-tools full --show-reasoning collapsed --logs all
```

`--show-subagents` accepts `collapsed` (default), `full`, or `hidden`. `full` also writes each subagent message and tool call to the transcript, and `hidden` leaves subagent tasks out of the transcript and the drawer.

Use `--host` and `--port` to bind the local server, or `--no-ui` to run without the terminal UI. Set `EVE_TUI_RENDER_MARKDOWN=0` to show responses as plain text instead of rendered Markdown. See the [`eve dev` CLI reference](../reference/cli#eve-dev) for the complete option list, accepted values, and defaults.

## Connect to a deployment

`eve remote connect` opens the terminal UI against an existing eve server instead of starting one locally:

```bash
eve remote connect --url https://your-app.vercel.app
```

To send credentials or custom request headers, use a URL with HTTP Basic credentials or repeat `-H, --header`:

```bash
eve remote connect --url https://user:pass@your-app.example.com
eve remote connect --url https://your-app.example.com -H 'Authorization: Bearer your_token_here'
```

Remote Vercel sessions reuse an authorized Vercel CLI session. They don't open a login flow or change the local project's Vercel link or `.env.local`.

When Deployment Protection blocks startup, eve verifies the target project and offers to add a Trusted Sources rule. The rule grants development access to that deployment's environment, and eve then rechecks access. Cancelling preserves your draft; rerun `eve remote connect --url <url>` to try again. If you can't change the project's policy, provide `VERCEL_AUTOMATION_BYPASS_SECRET` or ask a project administrator to configure access in Deployment Protection settings.

## What to read next

- [Instrumentation](../observability/instrumentation): traces, OpenTelemetry, and diagnostics.
- [CLI](../reference/cli): commands and flags.
- [Agent Client Protocol (ACP)](../protocols/acp): drive the same agent from ACP clients such as Zed instead of the TUI.
