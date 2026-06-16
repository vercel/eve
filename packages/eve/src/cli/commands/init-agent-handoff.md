Before editing the scaffold, read the relevant guide in
`{{projectPath}}/node_modules/eve/docs/`.

Then open `{{projectPath}}/agent/instructions.md` and replace the placeholder
with what the user said the agent should do (the purpose you collected). This
is the agent's always-on system prompt.

Do not start `eve dev` because it is interactive. Give the user this command to
run when they are ready:

    cd {{projectPath}}
    {{devCommand}}
