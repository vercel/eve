## Scaffold

First settle the target: a new project, or the agent added to an existing
directory? For a new project, propose a name and ask the user to confirm it; for
an existing one, ask for the directory.

For a new project, run (append `--channel-web-nextjs` only if the user wants Web
Chat):

    npx eve@latest init <name>

This creates the project, installs its dependencies, and initializes Git. Since a
coding agent launched init, it prints a development handoff instead of starting
the interactive terminal UI.

If the user wants a reusable extension package instead of an agent, run
`npx eve@latest extension init <name>` and follow that command's next steps.

For an existing app, run `npx eve@latest init .` from its directory. This adds the
agent and missing dependencies while leaving the existing Git repository and app
scripts alone. If init cannot be used, install by hand with
`npm install eve@latest ai zod`; manual installation does not add package scripts.
