# eve-selfmod

A development-only source editing subagent for [eve](https://eve.dev).

Install the package and scaffold a declared subagent from the eve registry:

```sh
eve add eve-selfmod
```

The command creates:

```text
agent/subagents/selfmod/
├── agent.ts
├── sandbox.ts
├── extensions/
│   └── selfmod.ts
└── tools/
    ├── bash.ts
    └── write_file.ts
```

```ts
// agent/subagents/selfmod/agent.ts
export { default } from "eve-selfmod/agent";

// agent/subagents/selfmod/sandbox.ts
export { default } from "eve-selfmod/sandbox";

// agent/subagents/selfmod/extensions/selfmod.ts
export { default } from "eve-selfmod";

// agent/subagents/selfmod/tools/bash.ts and write_file.ts
import { disableTool } from "eve/tools";
export default disableTool();
```

The extension gives only the `selfmod` subagent a proposal tool and an approval-gated finalization tool. The scaffold disables the two default tools that can write to its sandbox, so source changes must pass through approval. Keep both disable files in place; the sandbox mount is writable so the finalization tool can apply approved edits.
