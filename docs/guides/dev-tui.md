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
 Use /add to install integrations from the registry.
```

If agent discovery reported problems, an error and warning count renders between the two lines. Instructions, tools, skills, and subagents are one `eve info` away, and `/help` lists every command. The TUI also runs a startup check. A fresh `eve init` starts local `eve dev` with `/model` prefilled. That input starts onboarding: the flow installs the Vercel CLI if needed, asks you to log in if needed, opens `/model`, then offers categorized next steps for channels, connections, capabilities, and observability through the registry before the first prompt. Other `eve dev` sessions show missing setup as an attention line, with each command's outcome hanging under it on a `⎿` connector.

## Reading the transcript

The conversation streams straight into your terminal's normal scrollback, so you keep native scrolling, copy and paste, and a transcript that persists after you exit. The scrollback holds your prompts, the agent's replies, reasoning, tool calls, nested subagents, connection-authorization prompts, and any captured `stdout`, `stderr`, or sandbox lifecycle lines.

Each turn renders without boxes. A colored gutter glyph marks who is speaking, tool calls collapse to a one-line summary (`✓ get_weather  city="SF" → 73°F`), and a subagent's work is indented beneath its `◆` header. When input is ready, the prompt stays bare until you type. A green circle-dot pulses while the agent is waiting to answer and disappears when reasoning or answer content begins.

A persistent line beneath the prompt or status shows the model — with its authored reasoning level and a `↯` marker when the Gateway priority tier is on (`xai/grok-4.5@xhigh ↯`) — and the linked Vercel project. The Vercel segment stays hidden until the directory is linked. Local sessions lead with a gray `:port` badge. Remote sessions lead with a padded `↗ project (environment)` badge, or the host when Vercel cannot resolve the deployment. The badge is gray while checking or unavailable, yellow while authentication is required or failed, and blue when connected. Status segments separate with plain whitespace. Remote status lines omit AI Gateway endpoint state.

Errors render compactly with docs links highlighted. A code bug escaping your agent's own code shows its stack trace dim beneath the error headline. Dev-server rebuilds condense into one status row that updates in place (`tui/setup-panel.ts changed · rebuilding…`, then `· rebuilt`); only the latest rebuild shows, and paths shrink to their last two components.

## Slash commands

Each command echoes as an invocation line, asks through a bordered panel that takes the input area's place (one question at a time, separate from the chat transcript), and finishes with a one-line `⎿` result. Loading states stay on the ephemeral status line instead of piling into the transcript; model, registry, and the Vercel CLI commands (`/vc:install`, `/vc:login`) use the same green square pulse as the build phase, while `/deploy` keeps a spinner. A setup waiting for browser action changes that pulse and the word "browser" to yellow. Setup menus render the selected option with a filled arrow and an inverse label padded by one space on each side. Text prompts use a blinking block cursor over the character at the caret. The selected label is blue normally and yellow for warning rows.

| Command       | Does                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/model`      | Opens a configure menu that loops until Done (or Esc). See [Configure the model and provider](#configure-the-model-and-provider).                            |
| `/add`        | Adds an integration from the registry or an item address entered directly.                                                                                   |
| `/deploy`     | Ships the agent to Vercel production, linking the directory first when it is unlinked.                                                                       |
| `/vc:install` | Installs the Vercel CLI. Available locally and on a remote session.                                                                                          |
| `/vc:login`   | Logs in to Vercel locally. On a remote session, resolves the deployment's project, refreshes its OIDC token, and confirms any required Trusted Sources rule. |
| `/loglevel`   | Switches which logs the transcript shows. See [Control what logs show](#control-what-logs-show).                                                             |
| `/traces`     | Opens the full-screen local trace viewer. See [Inspect traces](#inspect-traces).                                                                             |
| `/new`        | Starts a fresh session.                                                                                                                                      |
| `/compact`    | Queues context compaction for the current session without sending a message.                                                                                 |
| `/exit`       | Quits the TUI.                                                                                                                                               |
| `/help`       | Lists the commands available for the current local or remote session.                                                                                        |

`/model`, `/add`, `/deploy`, and `/traces` manage the local agent or its linked project. They are available only when `eve dev` runs the server locally, not when connected to a remote server with `--url`.

### Configure the model and provider

Bare `/model` opens the configure menu; its Change model row summarizes the draft (`xai/grok-4.5@high ↯`). When no provider is configured, it opens the provider picker directly and Esc returns to the configure menu. "Change model" opens a value menu — **Model**, **Reasoning effort** (a `●─◉─○` track beside the drafted level), **Service tier** (`fast ↯` or `normal`), and **Done**. Reasoning and tier adjust in place: `←`/`→` (Tab acts as `→`) move the highlighted row's value as a ring — past the top wraps to the bottom and vice versa — sliding the reasoning track over the model's supported effort levels or flipping the tier. An unset reasoning draft shows an empty track; the first `→` enters the ring at the lowest level, `←` at the highest. Picking a model snaps a drafted level the new model cannot serve to its closest supported one, clearing it when the model has no adjustable reasoning. Enter on the Model row opens the searchable Vercel AI Gateway catalog as `▏`-railed model ids, pre-selected on the model the runtime is serving; Esc backs out without changing it. A model with no adjustable reasoning says so on a disabled row, and a model the catalog prices no priority tier for shows no tier row at all. The menu's Done hands the draft to the configure menu, whose own Done commits everything through one atomic edit of your agent's authored source, reporting success only after eve confirms the new id. A completed model or provider change closes the menu and returns its result to the transcript; Done without changes or Esc closes it without one, and Esc notes any discarded draft. `/model <provider/model-id>` applies one directly, skipping the menu.

The provider row opens one menu: AI Gateway via a project, AI Gateway via `AI_GATEWAY_API_KEY`, or **Other providers**. The currently-active provider renders checked with its status beneath it ("Linked to **my-project** in team **my-team**", or "`AI_GATEWAY_API_KEY` set in `.env.local`"), and the cursor opens on it with a `↵ change` badge. The key option becomes a masked input on an `⎿` rail when highlighted, with a `↵ validate` badge after it. Enter validates it without replacing the menu — a `▪ validating` badge while it checks, a red `⨯ API key is not valid` badge on rejection; retrying or editing clears that result. With a non-empty key, the first Esc or Ctrl-C clears the input and the second dismisses the menu. An accepted key is saved to `.env.local` and reported as one `AI_GATEWAY_API_KEY set.` line. The project option asks for a Vercel team, opens that team's recent projects with the project named after your agent suggested first (searching the team for it when it is not among the recents), and lets you search all projects for older matches. Vercel links the selected project, eve verifies its project ID, then pulls its environment into `.env.local`. The **Other providers** option shows direct-provider wiring instructions and leaves the existing setup untouched. The dev server reloads env files and refreshes the status bar automatically, with no restart needed.

The provider row demands attention (a bold yellow "Configure model access" with a yellow "Not configured" hint that dims when unselected and uses the terminal foreground when selected) until a link or gateway credential is detected, then names the connection afterward (for example "AI Gateway (Linked to my-project in my-team)"). Setup menus mark the cursor row with a padded, filled-arrow inverse label that inherits the row's accent: blue normally and yellow for warning rows. In stacked menus, the selected row's description appears directly beneath that option. The completed command's outcome stays in the transcript after the panel closes. When a turn fails because AI Gateway authentication is missing or stale, the error points you at `/model` directly.

### Add registry integrations

`/add` groups integrations by their role: **Channels** for where people talk to your agent, **MCP connections** for external services and data, **Extensions** for reusable capabilities, and **Observability** for tracing and evaluation. Pick a category to open its searchable catalog from the official eve registry and the registry namespaces configured in `package.json`, or browse every integration. Each result shows its source beside its name, such as `Vercel` or a configured registry namespace. Select a result to review its source, packages, environment variables, and target files before adding it, or enter an official item path, configured namespace address, or HTTP(S) URL directly in the search bar. After an add attempt finishes, the panel closes instead of returning to the catalog.

MCP connection registry items install their definition and then configure Vercel Connect through the same `/add` flow. If the directory is unlinked, setup first offers to create or link a project. Run `eve add connection/<name>` for the equivalent CLI flow.

## Keyboard shortcuts

Chat and freeform `ask_question` inputs behave like a shell line editor.

| Key                                            | Action                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Enter`                                        | Submit the message or question response. While a turn is running, queue the message for the next turn.            |
| `Esc`                                          | While a turn runs: pop the oldest queued message and steer with it; with nothing queued, press twice to cancel.   |
| `Shift+Enter`                                  | Insert a newline without sending (needs a terminal that reports modified keys).                                   |
| `Ctrl+C`                                       | Interrupt a running turn. At the chat or freeform-question prompt, clear non-empty input; when empty, quit.       |
| `↑` / `↓`                                      | Move between input lines; at a chat-buffer edge, navigate messages you have sent this session.                    |
| `←` / `→`, `Home` / `End`, `Ctrl+A` / `Ctrl+E` | Move the caret; Home/End stay within the current line.                                                            |
| `Ctrl+U` / `Ctrl+K` / `Ctrl+W`                 | Delete to the start of the line, to its end, or through the previous word.                                        |
| `Ctrl+L`                                       | Cycle the log display mode (`none → all → stderr → sandbox → none`) and briefly show the mode in the status line. |
| `Ctrl+R`                                       | Redraw the screen.                                                                                                |

In terminals that support bracketed paste, pasting multi-line text into chat or a freeform question inserts it intact and renders one row per line rather than submitting at the first line. `Shift+Enter` adds a line by hand. The input grows down to the available terminal height, then scrolls to keep the caret visible; `Enter` submits the whole response.

### Queue and steer while the agent works

Sending a message while a turn is still running does not interrupt it — the message joins a queue of up to five, pinned in a panel directly above the input with one line per message. When the turn ends, the queued messages coalesce into the next turn's message.

`Esc` steers instead of waiting: it pops the oldest queued message, cancels the running turn cooperatively, and submits the popped message as the replacement turn. In the transcript, a steered message carries an accent `↑` on its own line above its gutter bar; a queued message that waited for the boundary carries it below. Any remaining messages stay queued behind it. With nothing queued, the first `Esc` arms cancellation and a second `Esc` cancels the turn. Unlike `Ctrl+C` — which drops the stream client-side — a cancelled turn ends cleanly on the server and the session keeps its context; the conversation picks up at the next prompt.

If a turn fails terminally (the server session dies or the connection drops), the TUI starts a fresh session and notes it inline so you can keep going. Server-side context resets with the old session. Messages still queued when a turn is interrupted or fails are restored into the next prompt's input instead of being sent blind.

## Answer the agent inline

When the agent needs something from you, the TUI asks inline.

- Tool approvals are a `y` or `n`.
- Option questions let you pick with `↑` / `↓` and `Enter`, or you can compose a multi-line freeform answer.
- If a tool needs an authorized [connection](../connections), the URL shows up right in the transcript, and the turn picks back up once you finish the flow. The same local `eve dev` server owns the callback route, so keep that command running until the browser returns. `eve dev --url` connects to an already-running server and does not start a local callback host.

## Control what logs show

By default, `eve dev` shows `stderr` and keeps stdout and sandbox lines buffered but hidden. Captured server `stdout` and `stderr` render as dim, indented log runs behind a `│` rule (consecutive lines from the same source share one label), while sandbox lifecycle lines use their own label.

- `/loglevel <all|stderr|sandbox|none>` switches what the transcript shows, retroactively. Bare `/loglevel` reports the current mode.
- `--logs <all|stderr|sandbox|none>` sets the starting mode at launch (default `stderr`).
- `Ctrl+L` at the idle prompt cycles `none → all → stderr → sandbox → none`.

Every captured line, tool failure, workflow error, and eve framework log record also lands in a private per-process diagnostic log under `.eve/logs/`, regardless of the display mode. The file is JSON Lines: each line is one JSON record with `at` and `source` fields (framework log records add `level`, `namespace`, `message`, and `fields`), so it parses with any JSONL tool — `jq -c 'select(.source=="tool")'` — even when a payload spans many stack-trace lines. Long stderr output collapses in the transcript to a one-line summary pointing at the file (the raw text stays available in the `all` mode). Read the logs with `eve logs` — see the [CLI reference](../reference/cli#eve-logs).

Each log has a same-named `.dump` sibling — one JSON document with environment diagnostics (eve, Node.js, and Vercel CLI versions, the Vercel CLI path, and the size of the local session store) plus running session stats: prompts, token usage, tool calls by name, and subagent dispatches. `eve logs --dump` prints the dump and the log together as one parseable report to attach when filing an issue.

## Inspect traces

`/traces` opens a full-screen viewer over the local trace spool (`.eve/traces/v1`) that `eve dev` writes while you chat — see [Zero-config local traces](instrumentation#zero-config-local-traces). It reads the spool files directly and refreshes about once a second, so spans from the current session stream in live. The viewer takes over the terminal's alternate screen; closing it restores the transcript exactly where you left it.

The viewer opens on your current session's trace (or the most recent one). It re-tells the trace as a chat-like flow of cards: the system prompt sits at the top as a collapsed card, then user and assistant messages (assistant cards carry model, duration, token, and gateway cost metadata), and tool calls show their inputs and results inline. Work a subagent performed appears in the same flow, ordered by when it happened — between the parent's dispatch step and its resumed reply — with a dim `subagent` badge (`subagent:<name>` when the dispatch named one) on every card of the delegated turn; the delegated prompt renders as a `task` card rather than a `user` message. Error spans paint their whole card red. The header names the agent, session, span count, and duration, plus a `● live` badge while spans are still landing. `/traces <trace>` opens a specific trace by id prefix.

| Key       | Action                                                                   |
| --------- | ------------------------------------------------------------------------ |
| `↑` / `↓` | Move the card selection (scroll the attributes panel when it has focus). |
| `←` / `→` | Expand / collapse the selected card (only cards with hidden content).    |
| `Enter`   | Open the attributes panel for the selected card; close it when open.     |
| `Tab`     | Move focus between the conversation and the attributes panel.            |
| `[` / `]` | Cycle to the next / previous trace.                                      |
| `Esc`     | Close the panel (or unfocus it), otherwise close the viewer.             |
| `q`       | Close the viewer.                                                        |

`←`/`→` or a mouse click expands a card to its full contents (the system prompt, long payloads) and collapses it back; cards that already fit have nothing to expand. The scroll wheel scrolls the conversation (or the attributes panel when the pointer is over it). Dragging with the mouse selects text — the selection highlights as you drag, and releasing copies it to your clipboard with a `Copied to clipboard` toast in the top-right corner; `Esc` cancels an in-flight selection. The attributes panel opens on the right and stays metadata-only — status, timing, ids, and the span's non-payload OTLP attributes — since the cards already carry the payloads. Model spans capture the system prompt, the prompt messages (rendered as a chat transcript), and the response (text, tool calls, finish reason); tool-call spans capture the call arguments and result, pretty-printed — each capped at 32 KB, with provider transport metadata stripped. When a conversation's messages exceed the cap, the oldest messages are dropped and the transcript notes how many were omitted. Set `EVE_TRACES_CONTENT=off` to stop capturing payload content. With no spans yet, the viewer shows an empty state and keeps watching; if tracing is disabled (`EVE_TRACES=off`) it says so instead.

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

The bare URL is shorthand for `--url`; it cannot be combined with `--host`, `--port`, or `--no-ui`. For HTTP Basic auth, put credentials in the URL; eve sends them as a Basic `Authorization` header and strips them from the server URL before connecting:

```bash
eve dev https://user:pass@<your-app>
```

For bearer tokens or custom schemes, repeat `-H, --header` to attach request headers.

Query parameters in the target URL are preserved on every request, including
session POSTs and event streams. This also supports deployment-protection URLs
that carry their bypass credential in the query string.

At startup the TUI asks Vercel to resolve the remote origin under the active scope. A resolved response is the authority for a project-scoped OIDC token—refreshing an expired development token when refresh credentials exist—or an automation-bypass secret. An unresolved host is probed anonymously. The TUI then requests `/eve/v1/info`, with a ten-second timeout. A successful response marks the remote ready. An eve OIDC challenge, Vercel Deployment Protection challenge, or `TRUSTED_SOURCES_ENVIRONMENT_MISMATCH` opens `/vc:login` automatically; ordinary network failures and server errors remain remote-availability errors and do not start an authentication flow. Esc or Ctrl-C cancels the authentication flow.

In a remote session, `/vc:login` first resolves the deployment's Vercel project from its URL. If the active Vercel scope cannot resolve it, the flow asks for another team and reruns the lookup in that team's scope. If the CLI is logged out, the same panel runs the browser login first. The flow asks before adding any required Trusted Sources rule and requests a project-scoped token through `@vercel/oidc`. It does not relink the directory or modify `.env.local`. Finally, it retries `/eve/v1/info` to prove the credential works. A failure reports any login or Trusted Sources update that completed before it stopped.

The project-scoped token represents the resolved project's Development environment. Vercel already allows a project's Development environment to call its own Preview deployments by default. For a Production or custom-environment target, `/vc:login` shows the exact Development-to-target rule before changing that project's Trusted Sources. Eve preserves existing entries. When it creates an explicit rule, it also carries Vercel's default self-access rows forward because saved rules replace those defaults. See Vercel's [Trusted Sources guide](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources), [error reference](https://vercel.com/docs/errors/trusted_sources_environment_mismatch), and [OIDC token anatomy](https://vercel.com/docs/oidc/reference#oidc-token-anatomy).

`VERCEL_AUTOMATION_BYPASS_SECRET` remains available for a Protection Bypass for Automation token. See [Deploy to Vercel](./deployment/vercel#verify-the-deployment) for the smoke-test flow.

## What to read next

- [Observability](./instrumentation): OpenTelemetry, run tags, and common failures.
- [CLI](../reference/cli): every command and flag.
