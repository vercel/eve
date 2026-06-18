Before editing the scaffold, read the relevant guide in
`{{projectPath}}/node_modules/eve/docs/`.

Then open `{{projectPath}}/agent/instructions.md` and replace the placeholder
with what the user said the agent should do (the purpose you collected). This
is the agent's always-on system prompt.

For runtime verification, start eve without the terminal UI in a controllable
background process. Wait for the server URL, run the checks, then stop it:

    cd {{projectPath}}
    {{devCommand}} --no-ui

Give the user the interactive command to run when they are ready:

    cd {{projectPath}}
    {{devCommand}}
