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
└── extensions/
    └── selfmod.ts
```

```ts
// agent/subagents/selfmod/agent.ts
export { default } from "eve-selfmod/agent";

// agent/subagents/selfmod/sandbox.ts
export { default } from "eve-selfmod/sandbox";

// agent/subagents/selfmod/extensions/selfmod.ts
export { default } from "eve-selfmod";
```

The sandbox mounts the application's authored `agent/` directory read-write at `/source`. The subagent can inspect and edit that source directly with eve's default bash and filesystem tools during development.

The mounted extension provides the source-editing instructions. Future tools, skills, and other extension contributions can ship from `eve-selfmod` without changing the registry scaffold.
