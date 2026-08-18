# @eve/self-modification

A development-only source editing subagent for [eve](https://eve.dev).

Install the package and scaffold a declared subagent from the eve registry:

```sh
eve add experimental/self-modification
```

The command creates one self-modification configuration and thin filesystem entrypoints:

```text
agent/subagents/self-modification/
├── config.ts
├── agent.ts
├── sandbox.ts
└── extensions/
    └── selfmod.ts
```

```ts
// agent/subagents/self-modification/config.ts
import { defineSelfModification } from "@eve/self-modification/config";

export const selfModification = defineSelfModification({
  model: "anthropic/claude-sonnet-5",
});

// agent/subagents/self-modification/agent.ts
import { selfModification } from "./config";
export default selfModification.agent;

// agent/subagents/self-modification/sandbox.ts
import { selfModification } from "./config";
export default selfModification.sandbox;

// agent/subagents/self-modification/extensions/selfmod.ts
export { default } from "@eve/self-modification";
```

`defineSelfModification` returns the coordinated subagent, sandbox, and extension definitions. Set `model` in the shared configuration to choose the self-modification subagent's model; it defaults to `anthropic/claude-sonnet-5`. The extension entrypoint remains a direct package mount so eve can discover its extension contributions statically. With no configuration it preserves the development-only behavior: the sandbox mounts the application's authored `agent/` directory read-write at `/source` and the installed eve package's version-matched documentation read-only at `/eve-docs`. The extension contributes the official eve authoring skill, adapted to use that documentation mount, and `selfmod__replace_in_file` for exact targeted edits without rewriting complete files. Its instructions direct independent `glob`, `grep`, and `read_file` calls to run concurrently.
