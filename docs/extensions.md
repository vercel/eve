---
title: "Extensions"
description: "Package reusable eve capabilities and mount them from npm or a monorepo workspace."
---

An extension is a package of eve tools, channels, connections, skills, schedules, subagents, instruction fragments, and hooks. An agent installs the package as a dependency and mounts it with a file under `agent/extensions/`. Use an extension to share the same tools and skills across agents, from npm or from a monorepo workspace.

To add a ready-made extension with `eve add`, see [Add Integrations](./install-integrations).

## Author: create an extension

### Create the package

Start with the extension scaffold:

```bash
npx eve@latest extension init my-crm
```

The command creates the package with `extension/extension.ts`, TypeScript configuration, and build and publish metadata. It also installs dependencies and initializes Git. Files under `extension/` follow the same layout as an agent:

```
@acme/crm/
  package.json
  extension/
    extension.ts
    tools/search.ts
    channels/webhook.ts
    connections/api.ts
    skills/triage/SKILL.md
    schedules/sync.ts
    subagents/reviewer/agent.ts
    instructions.md
    hooks/audit.ts
    lib/http.ts
```

Each directory accepts the same static and dynamic forms as in an agent. For example, `extension/instructions.ts` works like `extension/instructions.md`, and `extension/connections/` can contain `defineDynamic(...)`. Keep shared code in `extension/lib/`.

Names come from paths, so call the tool `search`, not `crm_search`. The agent's mount adds a prefix such as `crm__`; see [Mount it](#mount-it).

The extension root can't declare agent configuration, instrumentation,
[memory](./memory), a sandbox, or nested extensions, because the agent that
mounts the extension decides those. A subagent under `extension/subagents/` has
its own agent configuration, memory, and sandbox like any other
[declared subagent](./subagents).

### Add configuration and contributions

`extension/extension.ts` default-exports a `defineExtension` handle. Give it a [Standard Schema](https://standardschema.dev) when the agent that mounts it provides settings:

```ts title="extension/extension.ts"
import { defineExtension } from "eve/extension";
import { z } from "zod";

export default defineExtension({
  config: z.object({
    apiKey: z.string(),
    baseUrl: z.string().url().default("https://api.acme.example"),
  }),
});
```

Any file in the extension, including a schedule handler, can import that handle to read the validated configuration, with defaults applied:

```ts title="extension/tools/search.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";

import extension from "../extension";

export default defineTool({
  description: "Search the CRM.",
  inputSchema: z.object({ query: z.string() }),
  async execute({ query }) {
    const { apiKey, baseUrl } = extension.config;
    return { query, baseUrl, authenticated: apiKey.length > 0 };
  },
});
```

If no configuration is needed, export `defineExtension()` and let agents re-export it directly. Config schemas must validate synchronously.

`defineState` keys belong to the mount path and state name, so two mounts of the same package don't share state; see [Mount it](#mount-it).

### Add a subagent

Author a subagent under `extension/subagents/<id>/` with the same files as an agent's [declared subagent](./subagents). Mounting the extension as `crm` exposes `extension/subagents/reviewer/` as `crm__reviewer`. The subagent's own tools, connections, skills, hooks, instructions, sandbox, and nested subagents stay inside it and keep their path-derived names. The subagent uses the extension's mount path for its state keys, but keeps its own state.

Files inside the subagent can import the extension handle. A tool under `extension/subagents/reviewer/tools/` reads the configuration from the agent's `agent/extensions/crm.ts` mount. The subagent can also mount another extension under `extension/subagents/<id>/extensions/`, with configuration taken from its own extension's configuration:

```ts
// extension/subagents/reviewer/extensions/search.ts
import search from "@acme/search";

import crm from "../../../extension.js";

export default search({ apiKey: crm.config.searchApiKey });
```

### Build and optionally publish

The scaffold's `package.json` declares separate source and distribution roots:

```jsonc title="package.json"
{
  "name": "my-crm",
  "version": "0.0.0",
  "type": "module",
  "eve": {
    "extension": {
      "source": "./extension",
      "dist": "./dist/extension",
      "externalDependencies": ["@acme/runtime-sdk"],
    },
  },
  "files": ["dist"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.mjs",
    },
    "./tools": {
      "types": "./dist/tools/index.d.ts",
      "default": "./dist/tools/index.mjs",
    },
  },
  "scripts": {
    "build": "eve extension build",
    "prepare": "eve extension build",
    "typecheck": "tsc",
  },
  "dependencies": {
    "@acme/runtime-sdk": "^x",
    "zod": "^x",
  },
  "devDependencies": {
    "@types/node": "^x",
    "eve": "x.y.z",
    "typescript": "^x",
  },
  "peerDependencies": {
    "eve": "*",
  },
  "engines": {
    "node": ">=24",
  },
}
```

The scaffold omits `engines` when it creates a workspace package.

Build the package with `eve extension build`:

```bash
eve extension build
```

`eve extension build` writes an agent-shaped `dist/extension` tree with skill assets, type declarations, and the eve version that built it. It also manages the package exports for the mount factory (`@acme/crm`) and tool definitions (`@acme/crm/tools`). Publish `dist/`; agents don't need the TypeScript source.

| Package entry                        | What to put there                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `devDependencies.eve`                | An exact version, which pins the authoring API and build tools                                                                          |
| `peerDependencies.eve`               | `*`, so the agent provides eve at runtime. eve checks the build's recorded version, not this range.                                     |
| `dependencies`                       | Runtime packages such as `zod` or an SDK. Most are bundled into the agent. Don't add eve here.                                          |
| `eve.extension.externalDependencies` | Packages that must keep a normal Node.js package layout at runtime, such as a native addon or an SDK that loads package-relative assets |

Each package in `externalDependencies` must also appear in `dependencies`, `optionalDependencies`, or `peerDependencies`. The agent keeps it external with its complete package tree. The agent author doesn't edit `agent.ts` or install the package directly.

A workspace-only extension uses the same package contract without publishing; see [Use an extension in a workspace](#use-an-extension-in-a-workspace).

## Consumer: install and mount an extension

A mount gives the extension's tools, channels, and other files a name prefix in your agent. eve copies nothing into your agent, so updating the package updates the mounted extension.

### Install the package

Install the extension with the agent project's package manager, for example pnpm:

```bash
pnpm add @acme/crm
```

### Mount it

Create a file under `agent/extensions/`. Its filename becomes the mount namespace. Call the extension's default export when it needs configuration:

```ts title="agent/extensions/crm.ts"
import crm from "@acme/crm";

export default crm({ apiKey: process.env.CRM_API_KEY! });
```

Set `CRM_API_KEY` in the agent's environment, such as `.env.local` for local development.

The mount adds `crm__` to each name: `tools/search.ts` becomes `crm__search`, `channels/webhook.ts` becomes `crm__webhook`, `schedules/sync.ts` becomes `crm__sync`, `connections/api.ts` becomes `crm__api`, and `subagents/reviewer/` becomes `crm__reviewer`. Channels keep their route paths, and schedules keep their cron expressions.

Don't name a mount after one of the agent's connections. A [connection reserves](/docs/connections) every name that starts with `<name>__`, so the compiler rejects the mounted tools and subagents. The name `eve` is reserved for [built-in tools](/docs/concepts/built-in-tools#eve__search-eve__tool-and-eve__skill).

For an extension with no configuration, mount its default export directly:

```ts title="agent/extensions/gizmo.ts"
export { default } from "@acme/gizmo";
```

The same mount shape works with an npm package, a workspace dependency, or a linked local package. Each mount binds its own configuration, even when two mounts use the same package.

Extension state belongs to the mount path, such as `extensions/crm` or `subagents/research/extensions/crm`. A flat `crm.ts` mount and a directory `crm/extension.ts` mount share a path. Moving or renaming a mount creates a new instance with new state keys. The agent's own state keys don't change.

### Use an extension in a workspace

A workspace extension is a regular extension package in the same monorepo as the agents that use it. Use one when several agents need the same tools and skills, or when private tools should change together with their agents. For example, a pnpm workspace can keep one extension next to two independently deployable agents:

```text
acme-agents/
├── pnpm-workspace.yaml
├── packages/
│   └── shared-capabilities/
│       ├── package.json
│       └── extension/
│           ├── extension.ts
│           ├── tools/
│           ├── skills/
│           └── hooks/
└── agents/
    ├── support/
    │   ├── package.json
    │   └── agent/extensions/shared.ts
    └── operations/
        ├── package.json
        └── agent/extensions/shared.ts
```

Make both the extension and agent directories workspace members:

```yaml title="pnpm-workspace.yaml"
packages:
  - "agents/*"
  - "packages/*"
```

Scaffold the extension from a directory the workspace configuration covers:

```bash
cd packages
npx eve@latest extension init shared-capabilities
```

Give the generated package the name agents will import. Add `"private": true` if it should never be published:

```jsonc title="packages/shared-capabilities/package.json"
{
  "name": "@acme/shared-capabilities",
  "private": true,
  "eve": {
    "extension": {
      "source": "./extension",
      "dist": "./dist/extension",
    },
  },
}
```

Each agent declares its own workspace dependency:

```jsonc title="agents/support/package.json"
{
  "dependencies": {
    "@acme/shared-capabilities": "workspace:*",
  },
}
```

Then each agent mounts the package:

```ts title="agents/support/agent/extensions/shared.ts"
export { default } from "@acme/shared-capabilities";
```

Each agent chooses its own mount name and configuration. For example, `shared.ts` contributes `shared__search`, while mounting the same package as `company.ts` in another agent contributes `company__search`.

#### Develop from source

`eve dev` builds mounted workspace extensions from source before it compiles the agent. It watches each extension's source, `package.json`, and TypeScript configuration, and rebuilds only the extension you changed. If an edit fails to build, the last successful build keeps running.

`eve build`, and `withEve` during `next build`, also build these extensions from source first, and skip an extension that is already up to date. Production builds don't need the package's `prepare` script, which package managers skip for no-op installs and with `--ignore-scripts`.

### Override a contribution

Use a directory mount to keep overrides beside the mount declaration in `extension.ts`:

```
agent/extensions/crm/
  extension.ts
  tools/search.ts
```

```ts title="agent/extensions/crm/extension.ts"
import crm from "@acme/crm";

export default crm({ apiKey: process.env.CRM_API_KEY! });
```

A channel, tool, connection, skill, schedule, or subagent in your mount directory with the same name replaces the extension's. To adjust an extension tool, import it from the package's `./tools` export and define it again:

```ts title="agent/extensions/crm/tools/search.ts"
import { search } from "@acme/crm/tools";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";

export default defineTool({ ...search, approval: always() });
```

To remove an extension tool, use `disableTool()` in its matching slot:

```ts title="agent/extensions/crm/tools/search.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

Hooks and instruction fragments add to the agent's own, so you can't replace them. A dynamic tool wins over a static tool with the same name, so replace a dynamic tool with a dynamic definition in the same file. `disableTool()` removes either kind.

You can also override from the agent root with the prefixed name. `agent/tools/crm__search.ts` replaces the extension's `tools/search.ts`, and wins over a directory-mount override.

### Computer-use overrides

The bundled `eve/extensions/computer-use` extension exports `computer_use` from
`eve/extensions/computer-use/tools`. Reuse that tool definition in a same-named
override, as with the [code extension's tools](/docs/code-extension#override-bundled-tools).

For a custom sandbox, `eve/extensions/computer-use/sandbox` exports
`installComputerUse(sandbox)` and `startComputerUse(sandbox)`. Run the installer
in the environment's preparation callback to install desktop packages and the
driver; it requires an apt-based image with root or passwordless sudo. Start
the managed display and driver after opening each session sandbox.

### Use an extension tool result in a hook

To keep an extension tool's result type in your hook, import its definition from `./tools` and pass it to [`toolResultFrom`](/docs/guides/hooks#narrowing-tool-results):

```ts title="agent/hooks/narrow-crm.ts"
import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import { call } from "eve/events";
import { search } from "@acme/crm/tools";

export default defineHook({
  events: {
    "call.settled"(event, ctx) {
      const match = toolResultFrom(call(ctx.view, event.data.callId), search);
      if (match) console.log(match.output);
    },
  },
});
```

`toolResultFrom` matches the mounted `crm__search` result by its original definition, not by the prefixed name. Extension authors should give each tool definition a distinct description so eve can tell the tools apart. Re-exporting the same definition, such as from a subagent's `tools/` directory, doesn't conflict.

### Bundled development extensions

Local `eve dev` mounts the bundled self-modification extension by default, without a file under `agent/extensions/`. Production builds don't include it. See [Self-Modification](./guides/self-modification).

### Compatibility

eve checks the eve version that built an extension before it loads the extension's code. A built extension needs that eve release or a later one. Build with the oldest release you want to support, and test with newer agents. An agent can't rebuild an installed extension that ships without source.

Sessions saved by eve 0.68 or earlier store extension state per package, not per mount. When such a session moves to a newer deployment, eve gives each value to the one mount that defines it. It drops values that no mount defines.

### Troubleshooting

| What you see                                                                                 | What to do                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Extension "<package>" was built with eve <version>.`                                        | Upgrade eve to that version or later, or install an extension built with your eve version.                                                                                                            |
| `Extension "<package>" requires distribution contract <n>, which this eve does not support.` | Rebuild the extension with your eve version, or install a compatible extension release.                                                                                                               |
| `Extension "<package>" has no valid compatibility manifest`                                  | Rebuild or reinstall the extension.                                                                                                                                                                   |
| The agent build stops with an error that names an extension package and its directory        | Fix the reported error, or run `eve extension build` in that package directory to build it on its own.                                                                                                |
| `Incompatible context state layout for key "<key>".`                                         | Continue the session on its original deployment, or start a new session. The session stays on its deployment because two or more mounts of one package define that state, so eve can't pick an owner. |

## What to read next

- [Integrations](/integrations): browse ready-to-install extensions using the Extensions filter
- [Code extension](/docs/code-extension): mount eve-code, the coding extension that ships in `eve`, and see its benchmark results
- [Tools](/docs/tools): static tools, approval, and tool output
- [Dynamic capabilities](/docs/guides/dynamic-capabilities): dynamic connections, tools, skills, and instructions
- [Instructions](/docs/instructions): static and TypeScript instructions
- [Skills](/docs/skills): package procedures and supporting files
- [Connections](/docs/connections): integrate external services
- [Channels](/docs/channels/overview): receive messages and expose routes
- [Schedules](/docs/schedules): run the agent on a cron cadence
- [Subagents](/docs/subagents): delegate to declared specialists
- [Hooks](/docs/guides/hooks): observe agent events
