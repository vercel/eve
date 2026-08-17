# @eve/selfmod

A development-only source editing subagent for [eve](https://eve.dev).

Install the package and scaffold a declared subagent from the eve registry:

```sh
eve add experimental/selfmod
```

The command creates one selfmod configuration and thin filesystem entrypoints:

```text
agent/subagents/selfmod/
├── config.ts
├── agent.ts
├── sandbox.ts
├── extensions/
│   └── selfmod.ts
└── tools/
    ├── bash.ts
    └── replace_in_file.ts
```

```ts
// agent/subagents/selfmod/config.ts
import { defineSelfmod } from "@eve/selfmod/config";

export const selfmod = defineSelfmod({
  model: "anthropic/claude-sonnet-5",
});

// agent/subagents/selfmod/agent.ts
import { selfmod } from "./config";
export default selfmod.agent;

// agent/subagents/selfmod/sandbox.ts
import { selfmod } from "./config";
export default selfmod.sandbox;

// agent/subagents/selfmod/extensions/selfmod.ts
export { default } from "@eve/selfmod";

// agent/subagents/selfmod/tools/bash.ts
import { disableTool } from "eve/tools";
export default disableTool();

// agent/subagents/selfmod/tools/replace_in_file.ts
export { default } from "@eve/selfmod/replace-in-file";
```

`defineSelfmod` returns the coordinated subagent, sandbox, and extension definitions. Set `model` in the shared configuration to choose the selfmod subagent's model; it defaults to `anthropic/claude-sonnet-5`. The extension entrypoint remains a direct package mount so eve can discover its extension contributions statically. With no configuration it preserves the development-only behavior: the sandbox mounts the application's authored `agent/` directory read-write at `/source` and the installed eve package's version-matched documentation read-only at `/eve-docs`. The extension contributes the official Eve authoring skill, adapted to use that documentation mount. The scaffold disables `bash`, directs independent `glob`, `grep`, and `read_file` calls to run concurrently, and provides `replace_in_file` for exact targeted edits without rewriting complete files.
