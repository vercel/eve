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
├── instructions.ts
└── sandbox.ts
```

```ts
// agent/subagents/selfmod/agent.ts
export { default } from "eve-selfmod/agent";

// agent/subagents/selfmod/instructions.ts
export { default } from "eve-selfmod/instructions";

// agent/subagents/selfmod/sandbox.ts
export { default } from "eve-selfmod/sandbox";
```

The sandbox mounts the application's authored `agent/` directory read-write at `/source`. The subagent can inspect and edit that source directly with eve's default bash and filesystem tools during development.
