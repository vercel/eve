# Set up an eve agent

eve is a filesystem-first framework for durable backend AI agents: the agent is a
directory of files — instructions, tools, connections, channels — that eve
compiles and runs. Work through this with the user.

Ask the questions one at a time, use the coding harness's prompt tools when
available, and do not guess.

## Collect intent

1. What should the agent do? This becomes its always-on purpose.
2. New project, or add the agent to an existing directory? For a new project,
   propose a name and ask the user to confirm it; for an existing one, ask for
   the directory.
3. Where should it be reachable? Every agent ships the built-in HTTP channel.
   On top of that:
   - **Web Chat** (a Next.js app): add it at init with `--channel-web-nextjs`.
   - **Slack** and other platforms: add after deploy with `eve channels add slack`.
     Credentials run through **Vercel Connect** — it provisions the bot token and
     verifies inbound webhooks, so there is no `SLACK_BOT_TOKEN` or signing secret
     to manage.
4. Which external systems does it need programmatic read/write access to — Slack,
   Salesforce, Linear, GitHub, your own API? Each becomes a connection under
   `agent/connections/`. When a system needs every end-user to sign in, wire its
   auth through **Vercel Connect** (`connect()` from `@vercel/connect/eve`), which
   handles consent, encrypted token storage, and refresh.

Reach for Vercel Connect for both channels and connections rather than
hand-managing tokens — it is the path to a working setup out of the box. See
https://vercel.com/docs/connect.

## Scaffold

For a new project, run (append `--channel-web-nextjs` only if the user wants
Web Chat):

    npx eve@latest init <name>

This creates the project, installs its dependencies, and initializes Git. Since a
coding agent launched init, it prints a development handoff instead of starting
the interactive terminal UI.

For an existing app, run `npx eve@latest init .` from its directory. This adds the
agent and missing dependencies while leaving the existing Git repository and app
scripts alone. If init cannot be used, install by hand with
`npm install eve@latest ai zod`; manual installation does not add package scripts.

## Build it out, then verify

Once eve is installed, the full docs are bundled at `node_modules/eve/docs/` and
match the installed version exactly. Read `README.md` there first, then the guide
for what you're adding — `connections`, `channels/slack`, and
`guides/auth-and-route-protection` (the Vercel Connect flow). Then:

- Put the purpose in `agent/instructions.md` (the always-on system prompt).
- Add a first typed tool under `agent/tools/` with `defineTool` from `eve/tools`
  and a Zod `inputSchema`.
- Start eve without the terminal UI in a controllable background process:
  `npx eve dev --no-ui`. Wait for the server URL, exercise the HTTP API with
  `POST /eve/v1/session`, stream `GET /eve/v1/session/:id/stream`, then send a
  follow-up with the returned `continuationToken`. Stop the dev process after
  verification.

Verify the project's typecheck passes, adapt the model and provider to the user's
data and use case, and don't commit unless the user asks.
