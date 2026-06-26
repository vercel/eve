---
title: "Dev TUI"
description: "Drive an eve agent locally in an interactive terminal UI. Chat, stream, approve tools, answer questions, tune the display, and point it at a deployment."
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

If agent discovery reported problems, an error and warning count renders between the two lines. Instructions, tools, skills, and subagents are one `eve info` away, and `/help` lists every command. The TUI also runs a startup check. When the runtime confirms that no model provider is configured, it opens the `/model` provider picker before the first prompt. Unknown or linked-but-incomplete credential states remain visible as an attention line, with each command's outcome hanging under it on a `⎿` connector.

## Reading the transcript

The conversation streams straight into your terminal's normal scrollback, so you keep native scrolling, copy and paste, and a transcript that persists after you exit. The scrollback holds your prompts, the agent's replies, reasoning, tool calls, nested subagents, connection-authorization prompts, and any captured `stdout`, `stderr`, or sandbox lifecycle lines.

Each turn renders without boxes. A colored gutter glyph marks who is speaking, tool calls collapse to a one-line summary (`✓ get_weather  city="SF" → 73°F`), and a subagent's work is indented beneath its `◆` header. When input is ready, the prompt stays bare until you type. A green circle-dot pulses while the agent is waiting to answer and disappears when reasoning or answer content begins.

A persistent line beneath the prompt or status shows the model, the session's token flow (`↑ 394.4K ↓ 4.3K`), the linked Vercel project, and a yellow `/deploy pending` marker once a channel added this session still needs `/deploy`. The Vercel segment stays hidden until the directory is linked. Local sessions lead with a gray `:port` badge. Remote sessions lead with a padded `↗ project (environment)` badge, or the host when Vercel cannot resolve the deployment. The badge is gray while checking or unavailable, yellow while authentication is required or failed, and blue when connected. Other status segments use `·` separators. Remote status lines omit AI Gateway endpoint state.

Errors render compactly with docs links highlighted. A code bug escaping your agent's own code shows its stack trace dim beneath the error headline. Dev-server rebuilds condense into one status row that updates in place (`tui/setup-panel.ts changed · rebuilding…`, then `· rebuilt`); only the latest rebuild shows, and paths shrink to their last two components.

## Slash commands

Each command echoes as an invocation line, asks through a bordered panel that takes the input area's place (one question at a time, separate from the chat transcript), and finishes with a one-line `⎿` result. Loading states stay on the ephemeral status line instead of piling into the transcript; model, channel, and the Vercel CLI commands (`/vc:install`, `/vc:login`) use the same green square pulse as the build phase, while `/deploy` keeps a spinner. Setup menus render the selected option with a filled arrow and an inverse label padded by one space on each side. Text prompts use a blinking block cursor over the character at the caret. The selected label is blue normally and yellow for warning rows.

| Command       | Does                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/model`      | Opens a configure menu that loops until Done (or Esc). See [Configure the model and provider](#configure-the-model-and-provider).                            |
| `/channels`   | Shows the agent's channel list and adds the one you pick. See [Add a channel](#add-a-channel).                                                               |
| `/deploy`     | Ships the agent to Vercel production, linking the directory first when it is unlinked.                                                                       |
| `/vc:install` | Installs the Vercel CLI. Available locally and on a remote session.                                                                                          |
| `/vc:login`   | Logs in to Vercel locally. On a remote session, resolves the deployment's project, refreshes its OIDC token, and confirms any required Trusted Sources rule. |
| `/loglevel`   | Switches which logs the transcript shows. See [Control what logs show](#control-what-logs-show).                                                             |
| `/new`        | Starts a fresh session.                                                                                                                                      |
| `/exit`       | Quits the TUI.                                                                                                                                               |
| `/help`       | Lists the commands available for the current local or remote session.                                                                                        |

`/model`, `/channels`, and `/deploy` manage the project and are available only when `eve dev` runs the server locally, not when connected to a remote server with `--url`.

### Configure the model and provider

Bare `/model` opens the configure menu. When no provider is configured, it opens the provider picker directly and Esc returns to the configure menu. "Change model" runs the same searchable model picker setup uses (the Vercel AI Gateway catalog, pre-selected on the model the runtime is serving). A model change is written into your agent's authored source, and the command reports success only after eve confirms the new id. A completed model or provider change closes the menu and returns its result to the transcript; Done or Esc closes it without a change. `/model <provider/model-id>` applies one directly, skipping the menu.

The provider row opens one menu: AI Gateway via a project, AI Gateway via `AI_GATEWAY_API_KEY`, or **Other providers**. The key option becomes a masked input when highlighted. Enter validates it without replacing the menu. A rejected key shows a red `⨯ Invalid key` beside the masked value; retrying or editing clears that result. With a non-empty key, the first Esc or Ctrl-C clears the input and the second cancels the menu. An accepted key is saved to `.env.local`. The project option asks for a Vercel team, opens that team's recent projects, and lets you search all projects for older matches. Vercel links the selected project, eve verifies its project ID, then pulls its environment into `.env.local`. The **Other providers** option shows direct-provider wiring instructions and leaves the existing setup untouched. The dev server reloads env files and refreshes the status bar automatically, with no restart needed.

The provider row demands attention (a bold yellow "Configure model access" with a yellow "Not configured" hint that dims when unselected and uses the terminal foreground when selected) until a link or gateway credential is detected, then names the connection afterward (for example "AI Gateway (Linked to my-project in my-team)"). Setup menus mark the cursor row with a padded, filled-arrow inverse label that inherits the row's accent: blue normally and yellow for warning rows. In stacked menus, the selected row's description appears directly beneath that option. The completed command's outcome stays in the transcript after the panel closes. When a turn fails because AI Gateway authentication is missing or stale, the error points you at `/model` directly.

### Add a channel

`/channels` shows the agent's channel list. Already-registered channels render as checked, focusable rows with an "Already installed" hint. Picking one adds it (including the Slack Connect provisioning), then installs the dependencies the scaffold added so the dev server can load the new channels right away. After each addition the list repaints with the channel checked, until Done (or Esc) leaves the flow.

## Keyboard shortcuts

Chat and freeform `ask_question` inputs behave like a shell line editor.

| Key                                            | Action                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Enter`                                        | Submit the message or question response.                                                                          |
| `Shift+Enter`                                  | Insert a newline without sending (needs a terminal that reports modified keys).                                   |
| `Ctrl+C`                                       | Interrupt a running turn. At the chat or freeform-question prompt, clear non-empty input; when empty, quit.       |
| `↑` / `↓`                                      | Move between input lines; at a chat-buffer edge, navigate messages you have sent this session.                    |
| `←` / `→`, `Home` / `End`, `Ctrl+A` / `Ctrl+E` | Move the caret; Home/End stay within the current line.                                                            |
| `Ctrl+U` / `Ctrl+K` / `Ctrl+W`                 | Delete to the start of the line, to its end, or through the previous word.                                        |
| `Ctrl+L`                                       | Cycle the log display mode (`none → all → stderr → sandbox → none`) and briefly show the mode in the status line. |
| `Ctrl+R`                                       | Redraw the screen.                                                                                                |

In terminals that support bracketed paste, pasting multi-line text into chat or a freeform question inserts it intact and renders one row per line rather than submitting at the first line. `Shift+Enter` adds a line by hand. The input grows down to the available terminal height, then scrolls to keep the caret visible; `Enter` submits the whole response.

If a turn fails terminally (the server session dies or the connection drops), the TUI starts a fresh session and notes it inline so you can keep going. Server-side context resets with the old session.

## Answer the agent inline

When the agent needs something from you, the TUI asks inline.

- Tool approvals are a `y` or `n`.
- Option questions let you pick with `↑` / `↓` and `Enter`, or you can compose a multi-line freeform answer.
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

The bare URL is shorthand for `--url`; it cannot be combined with `--host`, `--port`, or `--no-ui`.

At startup the TUI asks Vercel to resolve the remote origin under the active scope. A resolved response is the authority for a project-scoped OIDC token—refreshing an expired development token when refresh credentials exist—or an automation-bypass secret. An unresolved host is probed anonymously. The TUI then requests `/eve/v1/info`, with a ten-second timeout. A successful response marks the remote ready. An eve OIDC challenge, Vercel Deployment Protection challenge, or `TRUSTED_SOURCES_ENVIRONMENT_MISMATCH` opens `/vc:login` automatically; ordinary network failures and server errors remain remote-availability errors and do not start an authentication flow. Esc or Ctrl-C cancels the authentication flow.

In a remote session, `/vc:login` first resolves the deployment's Vercel project from its URL. If the active Vercel scope cannot resolve it, the flow asks for another team and reruns the lookup in that team's scope. If the CLI is logged out, the same panel runs the browser login first. The flow asks before adding any required Trusted Sources rule and requests a project-scoped token through `@vercel/oidc`. It does not relink the directory or modify `.env.local`. Finally, it retries `/eve/v1/info` to prove the credential works. A failure reports any login or Trusted Sources update that completed before it stopped.

The project-scoped token represents the resolved project's Development environment. Vercel already allows a project's Development environment to call its own Preview deployments by default. For a Production or custom-environment target, `/vc:login` shows the exact Development-to-target rule before changing that project's Trusted Sources. Eve preserves existing entries. When it creates an explicit rule, it also carries Vercel's default self-access rows forward because saved rules replace those defaults. See Vercel's [Trusted Sources guide](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources), [error reference](https://vercel.com/docs/errors/trusted_sources_environment_mismatch), and [OIDC token anatomy](https://vercel.com/docs/oidc/reference#oidc-token-anatomy).

`VERCEL_AUTOMATION_BYPASS_SECRET` remains available for a Protection Bypass for Automation token. See [Deployment](./deployment) for the smoke-test flow.

## What to read next

- [Observability](./instrumentation): OpenTelemetry, run tags, and common failures.
- [CLI](../reference/cli): every command and flag.
