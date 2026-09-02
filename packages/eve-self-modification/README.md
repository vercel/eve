# @eve/self-modification

A development-only source editing subagent for [eve](https://eve.dev).

Install the package and scaffold a declared subagent from the eve registry:

```sh
eve add experimental/self-modification
```

The command creates independent filesystem entrypoints for the subagent, sandbox, and extension:

```text
agent/subagents/self-modification/
├── agent.ts
├── sandbox.ts
└── extensions/
    └── selfmod.ts
```

```ts
// agent/subagents/self-modification/agent.ts
import { defineSelfModificationAgent } from "@eve/self-modification/agent";

export default defineSelfModificationAgent({
  model: "anthropic/claude-sonnet-5",
});

// agent/subagents/self-modification/sandbox.ts
export { default } from "@eve/self-modification/sandbox";

// agent/subagents/self-modification/extensions/selfmod.ts
export { default } from "@eve/self-modification";
```

Set `model` in the agent definition to choose the self-modification subagent's model; it defaults to `anthropic/claude-sonnet-5`. The sandbox mounts the application's authored `agent/` directory read-write at `/source`, local trace segments read-only at `/traces`, and the installed eve package's version-matched documentation read-only at `/eve-docs`.

The extension contributes `selfmod__edit_file` for one or more exact targeted edits to an existing file without rewriting it. Its instructions direct independent discovery calls to run concurrently and reserve `write_file` for new files or complete rewrites.

The extension also provides `selfmod__search_registry` to search the eve registry for channels, connections, extensions, and other integrations the project can add. Registry search is read-only: it reports each item's address, whether the authored tree already holds it, and the eve version it requires.

## Installing registry items

`selfmod__registry_add` installs an item from the configured eve registry — `eve add <address> --non-interactive --skip-setup` in the application root — so the subagent can add an existing integration instead of hand-writing one. It runs only under `eve dev`, requires approval the first time per session, and holds the authored-source watcher suspended for the whole install.

It installs only items that declare no setup command and no components. An item that declares either is reported back untouched: in the local dev TUI, the result opens the existing `/add <address>` setup panel automatically; headless development reports the shell command instead. Setup flows ask for credentials and open browser authorizations, and neither can be answered from a chat turn. No setup question ever reaches the model, and no secret ever enters the transcript.

An installed item's result names the environment variables it declares that are not set, so an item that installed cleanly but cannot yet work is reported as such rather than as bare success.
