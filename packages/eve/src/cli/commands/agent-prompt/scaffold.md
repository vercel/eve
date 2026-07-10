## Scaffold

First settle the target: a new agent project, an agent added to an existing
directory, or a reusable extension package? For a new project, propose a name
and ask the user to confirm it; for an existing one, ask for the directory.

For a new agent project, run (append `--channel-web-nextjs` only if the user
wants Web Chat):

    npx eve@latest init <name>

This creates the project, installs its dependencies, and initializes Git. Since a
coding agent launched init, it prints a development handoff instead of starting
the interactive terminal UI.

For a reusable extension package (tools/skills/hooks mounted into other agents),
run:

    npx eve@latest extension init <name>

That scaffolds an `ext/` package with `defineExtension`, installs dependencies,
and prints authoring/build/mount next steps. It does not start `eve dev`. Build
with `eve extension build` (or the package `build` script), not `eve build`.

For an existing app, run `npx eve@latest init .` from its directory. This adds the
agent and missing dependencies while leaving the existing Git repository and app
scripts alone. If init cannot be used, install by hand with
`npm install eve@latest ai zod`; manual installation does not add package scripts.
`eve extension init` cannot add to an existing project — always pass a new name.
