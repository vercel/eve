---
title: "Dev TUI"
description: "Drive an Eve agent locally in an interactive terminal UI. Chat, stream, approve tools, answer questions, tune the display, and point it at a deployment."
---

`eve dev` boots the local runtime and drops you into an interactive terminal UI. You chat with the agent, watch it stream, approve its tool calls, and answer the questions it asks back.

```bash
eve dev
```

On startup the TUI prints a brand line with your agent's name, plus a rotating tip (local sessions only).

```text
 eve weather-agent
 Use /channels to add more ways to reach your agent.
```

If agent discovery reported problems, an error and warning count renders between the two lines. Instructions, tools, skills, and subagents are one `eve info` away, and `/help` lists every command. The TUI also runs a startup check. A missing model-provider setup surfaces as an attention line (`⚠ 1 setup issue: model provider not linked · /model`) so the fix is visible before the first message fails, with each command's outcome hanging under it on a `⎿` connector.

## Reading the transcript

The conversation streams straight into your terminal's normal scrollback, so you keep native scrolling, copy and paste, and a transcript that persists after you exit. The scrollback holds your prompts, the agent's replies, reasoning, tool calls, nested subagents, connection-authorization prompts, and any captured `stdout`, `stderr`, or sandbox lifecycle lines.

Each turn renders without boxes. A colored gutter glyph marks who is speaking, tool calls collapse to a one-line summary (`✓ get_weather  city="SF" → 73°F`), and a subagent's work is indented beneath its `◆` header. When input is ready, the prompt stays bare until you type. While a turn or setup action owns the terminal, only its live status shows.

A persistent line beneath the prompt or status shows the model, the session's token flow (`↑ 394.4K ↓ 4.3K`), the linked Vercel project and team (`▲ my-agent (acme)`), and a yellow `/deploy pending` marker once a channel added this session still needs `/deploy`. The Vercel segment stays hidden until the directory is linked.

Errors render compactly with docs links highlighted. A code bug escaping your agent's own code shows its stack trace dim beneath the error headline. Dev-server rebuilds condense into one status row that updates in place (`tui/setup-panel.ts changed · rebuilding…`, then `· rebuilt`); only the latest rebuild shows, and paths shrink to their last two components.

## Slash commands

Each command echoes as an invocation line, asks through a bordered panel that takes the input area's place (one question at a time, separate from the chat transcript), and finishes with a one-line `⎿` result. Loading states stay on the ephemeral status line instead of piling into the transcript.

| Command     | Does                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `/model`    | Opens a configure menu that loops until Done (or Esc). See [Configure the model and provider](#configure-the-model-and-provider). |
| `/channels` | Shows the agent's channel list and adds the one you pick. See [Add a channel](#add-a-channel).                                    |
| `/deploy`   | Ships the agent to Vercel production, linking the directory first when it is unlinked.                                            |
| `/loglevel` | Switches which logs the transcript shows. See [Control what logs show](#control-what-logs-show).                                  |
| `/new`      | Starts a fresh session.                                                                                                           |
| `/exit`     | Quits the TUI.                                                                                                                    |
| `/help`     | Lists every command.                                                                                                              |

`/model`, `/channels`, and `/deploy` manage the project and are available only when `eve dev` runs the server locally, not when connected to a remote server with `--url`.

### Configure the model and provider

Bare `/model` opens the configure menu. "Change model" runs the same searchable model picker setup uses (the Vercel AI Gateway catalog, pre-selected on the model the runtime is serving). A model change is written into your agent's authored source, and the command reports success only after Eve confirms the new id. `/model <provider/model-id>` applies one directly, skipping the menu.

The provider row opens the provider questions: which model provider to use, and how to connect. Picking something other than Vercel AI Gateway shows wiring instructions for your own provider and stops there, leaving any existing setup untouched. For Vercel AI Gateway, you either paste your own `AI_GATEWAY_API_KEY` (saved straight to `.env.local`) or connect via a project. Connecting via a project asks for a Vercel team, opens that team's existing-project list (picking again re-links), then pulls the project's environment so an AI Gateway credential lands in `.env.local`. The dev server reloads env files automatically, with no restart needed.

The provider row demands attention (a bold yellow "Configure provider" with "Required to enable the agent") until a link or gateway credential is detected, then names the connection afterward (for example "AI Gateway (Linked to my-project in my-team)"). Each action's latest outcome stays visible beneath the menu (for example "✓ Model changed to openai/gpt-5.5"). When a turn fails because AI Gateway authentication is missing or stale, the error points you at `/model` directly.

### Add a channel

`/channels` shows the agent's channel list. Already-registered channels render as checked, focusable rows with an "Already installed" hint. Picking one adds it (including the Slack Connect provisioning), then installs the dependencies the scaffold added so the dev server can load the new channels right away. After each addition the list repaints with the channel checked, until Done (or Esc) leaves the flow.

## Keyboard shortcuts

The prompt input behaves like a shell line editor.

| Key                                            | Action                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Enter`                                        | Send the message.                                                                                                 |
| `Ctrl+C`                                       | Interrupt a running turn, or quit at the prompt.                                                                  |
| `↑` / `↓`                                      | Cycle through the messages you have sent this session.                                                            |
| `←` / `→`, `Home` / `End`, `Ctrl+A` / `Ctrl+E` | Move the caret.                                                                                                   |
| `Ctrl+U` / `Ctrl+K` / `Ctrl+W`                 | Kill the whole line, the rest of the line, or the previous word.                                                  |
| `Ctrl+L`                                       | Cycle the log display mode (`none → all → stderr → sandbox → none`) and briefly show the mode in the status line. |
| `Ctrl+R`                                       | Redraw the screen.                                                                                                |

If a turn fails terminally (the server session dies or the connection drops), the TUI starts a fresh session and notes it inline so you can keep going. Server-side context resets with the old session.

## Answer the agent inline

When the agent needs something from you, the TUI asks inline.

- Tool approvals are a `y` or `n`.
- Option questions let you pick with `↑` / `↓` and `Enter`, or you can type a freeform answer.
- If a tool needs an authorized [connection](../connections), the URL shows up right in the transcript, and the turn picks back up once you finish the flow.

## Control what logs show

By default, `eve dev` shows `stderr` and keeps stdout and sandbox lines buffered but hidden. Captured server `stdout` and `stderr` render as dim, indented log runs behind a `│` rule (consecutive lines from the same source share one label), while sandbox lifecycle lines use their own label.

- `/loglevel <all|stderr|sandbox|none>` switches what the transcript shows, retroactively. Bare `/loglevel` reports the current mode.
- `--logs <all|stderr|sandbox|none>` sets the starting mode at launch (default `stderr`).
- `Ctrl+L` at the idle prompt cycles `none → all → stderr → sandbox → none`.

## Display flags

Density flags control how much of each section renders. They accept `full`, `collapsed`, `auto-collapsed`, or `hidden`.

```bash
eve dev --tools full --assistant-response-stats tokens --context-size 200000
```

| Flag                                | Values                                             | Effect                                                  |
| ----------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `--tools <mode>`                    | `full` / `collapsed` / `auto-collapsed` / `hidden` | How tool calls render (default `auto-collapsed`).       |
| `--reasoning <mode>`                | `full` / `collapsed` / `auto-collapsed` / `hidden` | How reasoning renders (default `full`).                 |
| `--subagents <mode>`                | `full` / `collapsed` / `auto-collapsed` / `hidden` | How subagent sections render.                           |
| `--connection-auth <mode>`          | `full` / `collapsed` / `auto-collapsed` / `hidden` | How connection authorization renders.                   |
| `--assistant-response-stats <mode>` | `tokens` / `tokensPerSecond`                       | Which statistic the assistant header shows.             |
| `--context-size <tokens>`           | a token count                                      | Model context window size, shown as a usage percentage. |
| `--logs <mode>`                     | `all` / `stderr` / `sandbox` / `none`              | Which server and agent logs to show (default `stderr`). |

Connection flags: `--host` and `--port` bind the local server, and `--no-ui` runs headless (also the automatic fallback when stdout is not a TTY). See the [CLI](../reference/cli) for the full flag list.

## Remote: `eve dev <url>`

Pass a URL and the TUI talks to a running deployment instead of starting a local server, which is handy for a Vercel preview or your production app.

```bash
eve dev https://<your-app>
```

The bare URL is shorthand for `--url`. `--host`, `--port`, and `--no-ui` are ignored against a remote target. If the deployment sits behind Vercel preview protection, set `VERCEL_AUTOMATION_BYPASS_SECRET` locally first. See [Deployment](./deployment) for the smoke-test flow.

## What to read next

- [Observability](./instrumentation): OpenTelemetry, run tags, and common failures.
- [CLI](../reference/cli): every command and flag.
