# Build this eve agent with the user

The project at `{{workingDirectory}}` is already scaffolded. Work with the user to
complete it.

## Collect intent

If their intent is not already clear, ask one question at a time and do not
guess:

1. What should the agent do? This becomes its always-on purpose.
2. Which systems should it read from or write to? Add those as typed tools or
   connections under `agent/`.
3. Where should users reach it? Every agent has HTTP; add Web Chat or Slack only
   when the user wants them.
4. Does every end user need their own account with an external system? Use
   Vercel Connect for that authorization instead of hand-managing tokens.

## Build it out, then verify

Before editing the scaffold, read the relevant guide in
`{{workingDirectory}}/node_modules/eve/docs/`.

Then open `{{workingDirectory}}/agent/instructions.md` and replace the placeholder
with what the user said the agent should do (the purpose you collected). This
is the agent's always-on system prompt.

`{{devCommand}}` starts eve's HMR development server and opens the eve agent's
terminal REPL. It does not start or control this coding-agent session. Do not
use the bare command as a background verification process.

For runtime verification, start eve without the terminal UI in a controllable
background process. Wait for the server URL, run the checks, then stop it:

    cd {{workingDirectory}}
    {{devCommand}} --no-ui

Give the user the interactive command to run when they are ready to use their
agent's REPL:

    cd {{workingDirectory}}
    {{devCommand}}

Verify the project's typecheck, adapt the model and provider to the user's data
and use case, and do not commit unless the user asks.
