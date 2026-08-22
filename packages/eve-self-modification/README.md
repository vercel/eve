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

Set `model` in the agent definition to choose the self-modification subagent's model; it defaults to `anthropic/claude-sonnet-5`. The sandbox mounts the application's authored `agent/` directory read-write at `/source` and the installed eve package's version-matched documentation read-only at `/eve-docs`. The extension contributes the official eve authoring skill, adapted to use that documentation mount, and `selfmod__edit_file` for one or more exact targeted edits to an existing file without rewriting it. Its instructions direct independent discovery calls to run concurrently and reserve `write_file` for new files or complete rewrites.
