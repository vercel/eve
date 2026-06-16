---
title: "Dev TUI"
description: "Drive an Eve agent locally in an interactive terminal UI: chat, stream, approve tools, answer questions, tune the display, and point it at a deployment."
---

`eve dev` boots the local runtime and drops you into an interactive terminal UI. You chat with the agent, watch it stream, approve its tool calls, and answer the questions it asks back:

```bash
eve dev
```

On startup the TUI prints a brand line with your agent's name, plus a rotating tip (local sessions only):

```text
 eve weather-agent
 Use /channels to add more ways to reach your agent.
```

If agent discovery reported problems, an error/warning count renders between the two lines. Instructions, tools, skills, and subagents are one `eve info` away, and `/help` lists every command.

From there the conversation streams straight into your terminal's normal scrollback — your prompts, the agent's replies, reasoning, tool calls, nested subagents, connection-authorization prompts, and any captured `stdout`, `stderr`, or sandbox lifecycle lines — so you keep native scrolling, copy/paste, and a transcript that persists after you exit. Each turn is rendered without boxes: a colored gutter glyph marks who's speaking, tool calls collapse to a one-line summary (`✓ get_weather  city="SF" → 73°F`), and a subagent's work is indented beneath its `◆` header. A sticky footer keeps you oriented. When input is ready, the prompt stays bare until you type; while a turn or setup action owns the terminal, only its live status is shown. Beneath the prompt or status, a persistent line shows the model, the session's token flow (`↑ 394.4K ↓ 4.3K`), the linked Vercel project and team (`▲ my-agent (acme)`), and a yellow `/deploy pending` marker once a channel added this session still needs `/deploy`. The Vercel segment stays hidden until the directory is linked. Press `Enter` to send; `Ctrl+C` interrupts a running turn or quits at the prompt. Slash commands: `/new` starts a fresh session and `/exit` quits.

When `eve dev` runs the server locally, five more slash commands manage the project without leaving the session. `/vc` installs the Vercel CLI (a global install with your package manager) when it is missing — the fix command the "Vercel CLI not found" diagnostic points at. `/login` signs in to Vercel through the CLI's browser flow: the panel waits while you authenticate in the browser and Cancel stops waiting. These are the prerequisites the others route to — a logged-out `/model` link, `/channels` Slack provisioning, and `/deploy` all point you at `/login` (or `/vc` when the CLI itself is absent) instead of failing with a raw error, and a `403` from a team that enforces SSO routes to `/login` too (re-authenticating completes the team's SSO). Bare `/model` opens a configure menu that loops until Done (or Esc). "Change model" runs the same searchable model picker setup uses (the AI Gateway catalog, pre-selected on the model the runtime is serving); a model change is written into your agent's authored source, and the command reports success only after Eve confirms the new id (`/model <provider/model-id>` applies one directly, skipping the menu). The provider row opens the provider questions: which model provider to use (picking something other than AI Gateway shows wiring instructions for your own provider and stops there, leaving any existing setup untouched) and how to connect to AI Gateway — paste your own `AI_GATEWAY_API_KEY`, saved straight to `.env.local`, or connect via a project, which asks for a Vercel team and then opens that team's existing-project list (picking again re-links) before pulling the project's environment so an AI Gateway credential lands in `.env.local`; the dev server reloads env files automatically, no restart needed. The row demands attention (a bold yellow "Configure provider" with "Required to enable the agent") until a link or gateway credential is detected, then names the connection (e.g. "AI Gateway (Linked to my-project in my-team)") after, and each action's latest outcome stays visible beneath the menu (e.g. "✓ Model changed to openai/gpt-5.5"). `/channels` shows the agent's channel list — already-registered channels render as checked, focusable rows with an "Already installed" hint — and adds the one you pick, including the Slack Connect provisioning, then installs the dependencies the scaffold added so the dev server can load the new channels right away; after each addition the list repaints with the channel checked, until Done (or Esc) leaves the flow. `/deploy` ships the agent to Vercel production, linking first when the directory is unlinked. Each command echoes as an invocation line, asks through a bordered panel that takes the input area's place — one question at a time, clearly separate from the chat transcript — and finishes with a one-line `⎿` result; loading states stay on the ephemeral status line instead of piling into the transcript. These commands are not available when connected to a remote server with `--url`, and when a turn fails because AI Gateway authentication is missing or stale, the error points you at `/model` directly. The TUI also checks at startup: a missing model-provider setup surfaces as an attention line — `⚠ 1 setup issue: model provider not linked · /model` — so the fix is visible before the first message fails, and a logged-out Vercel session surfaces the same way as `⚠ 1 setup issue: not logged in · /login` (or `Vercel CLI not found · /vc` when the CLI itself is absent). Each command's outcome hangs under it with the `⎿` connector.

In the AI Gateway connection picker, "Connect via a project" is disabled when the Vercel CLI is missing, the CLI session is logged out, or Vercel cannot be reached. The disabled reason points to `/vc`, `/login`, or the network problem, while "Use my own key" remains available.

The prompt input behaves like a shell line editor: `↑`/`↓` cycle through the messages you've sent this session, `←`/`→`, Home/End, and `Ctrl+A`/`Ctrl+E` move the caret, and `Ctrl+U`/`Ctrl+K`/`Ctrl+W` kill the line, the rest of the line, or the previous word. If a turn fails terminally — the server session dies or the connection drops — the TUI starts a fresh session and notes it inline so you can keep going (server-side context resets with the old session). Errors render compactly, with docs links highlighted, and a code bug escaping your agent's own code shows its stack trace dim beneath the error headline. Captured server `stdout`/`stderr` renders as dim, indented log runs behind a `│` rule — consecutive lines from the same source share one label — while sandbox lifecycle lines use their own label. Dev-server rebuilds condense further, into one status row that updates in place: `tui/setup-panel.ts changed · rebuilding…`, then `· rebuilt`. Only the latest rebuild shows, and paths shrink to their last two components. By default, `eve dev` shows `stderr` and keeps stdout and sandbox lines buffered but hidden. `/loglevel <all|stderr|sandbox|none>` switches what the transcript shows retroactively, and `--logs` sets the starting mode. Bare `/loglevel` reports the current mode. At the idle prompt, `Ctrl+L` cycles `none → all → stderr → sandbox → none` and briefly shows the selected mode in the status line; `Ctrl+R` redraws.

The agent will sometimes need something from you, and the TUI asks inline. Tool approvals are a `y`/`n`. Option questions let you pick with `↑`/`↓` and `Enter`, or you can type a freeform answer. If a tool needs an authorized [connection](../connections), the URL shows up right in the transcript, and the turn picks back up once you've finished the flow.

Density flags accept `full` / `collapsed` / `auto-collapsed` / `hidden`:

```bash
eve dev --tools full --assistant-response-stats tokens --context-size 200000
```

Other useful flags: `--subagents`, `--reasoning`, `--logs <all|stderr|sandbox|none>`, `--host`/`--port`, and `--no-ui` (headless, also the automatic fallback when stdout isn't a TTY).

## Remote: `eve dev <url>`

Pass a URL and the TUI talks to a running deployment instead of spinning up a local server. That's handy for a Vercel preview or your production app:

```bash
eve dev https://<your-app>
```

The bare URL is shorthand for `--url`. `--host`, `--port`, and `--no-ui` are ignored against a remote target. If the deployment sits behind Vercel preview protection, set `VERCEL_AUTOMATION_BYPASS_SECRET` locally first. See [Deployment](./deployment) for the smoke-test flow.

## What to read next

- [instrumentation.ts](./instrumentation): OpenTelemetry, hooks, and the error catalog.
- [CLI](../reference/cli): every command and flag.
