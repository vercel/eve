## Build it out, then verify

Work from the project directory. Once eve is installed, the full docs are bundled
at `node_modules/eve/docs/` and match the installed version exactly. Read
`README.md` there first, then the guide for what you're adding, such as
`connections`, `channels/slack`, or `guides/auth-and-route-protection` for the
Vercel Connect flow.

- Put the purpose in `agent/instructions.md` (the always-on system prompt),
  replacing the scaffold's placeholder with what the user said the agent should
  do.
- Add a first typed tool under `agent/tools/` with `defineTool` from `eve/tools`
  and a Zod `inputSchema`.

`{{devCommand}}` starts eve's HMR development server and opens the agent's
terminal REPL. It does not start or control this coding-agent session, so don't
use the bare command as a background verification process. Start eve without the
terminal UI in a controllable background process instead:

    {{devCommand}} --no-ui

Wait for the server URL, then exercise the HTTP API: create a session with
`POST /eve/v1/session`, attach to `GET /eve/v1/session/:id/stream`, and send a
follow-up with the returned `continuationToken`. Stop the dev process after
verification.

When the user is ready to use their agent's REPL, give them the interactive
command to run from the project directory:

    {{devCommand}}

Verify the project's typecheck passes, adapt the model and provider to the user's
data and use case, and don't commit unless the user asks.
