# Set up an eve agent

Ask the user these questions one at a time. Use the coding harness's prompt
tools when available. Do not guess.

1. What should the agent do?
2. Create a new project or add the agent to an existing directory?
   For a new project, propose a name and ask the user to confirm it. For an
   existing project, ask for the directory.
3. For a new project, include Web Chat?

Then run:

    {{initCommand}} <target>

Add `--channel-web-nextjs` if the user wants Web Chat.
