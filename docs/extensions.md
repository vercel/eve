---
title: "Extensions"
description: "Package reusable eve capabilities and mount them from npm or a monorepo workspace."
---

Extensions package eve tools, connections, skills, instruction fragments, and hooks. An author builds an extension package; each agent that uses it declares the package as a dependency and mounts it. The package can be published to a registry or kept private inside a monorepo workspace.

This enables sharing many different capability sets. A browser extension might include several tools for navigating a site. A memory extension could use hooks to capture context and tools to recall it. A self-improving extension could pair hooks with dynamic instructions.

## Author: create an extension

### Create the package

Start with the extension scaffold:

```bash
npx eve@latest extension init my-crm
```

The command creates the package, installs dependencies, and initializes Git. It includes `extension/extension.ts`, TypeScript configuration, and the package metadata required to build and publish.

An extension uses the same file conventions as an agent for its contributions:

```
@acme/crm/
  package.json
  extension/
    extension.ts
    tools/search.ts
    connections/api.ts
    skills/triage/SKILL.md
    instructions.md
    hooks/audit.ts
    lib/http.ts
```

Each listed slot accepts the same authored forms as its agent counterpart. Static and dynamic tools, skills, and instructions all work in an extension: `extension/instructions.ts` is as valid as `extension/instructions.md`, and `extension/tools/` can contain `defineDynamic(...)`.

Names come from paths, so call the tool `search`, not `crm_search`; the consumer's mount adds the `crm__` prefix. Keep shared code in `extension/lib/`.

Keep agent configuration, sandboxes, schedules, and nested extensions in the consumer's agent.

### Add configuration and contributions

The author's `extension/extension.ts` default-exports a `defineExtension` handle. Give it a [Standard Schema](https://standardschema.dev) when consumers need to provide settings:

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

Contributions import that handle to read the validated configuration. Defaults have already been applied:

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

If no configuration is needed, export `defineExtension()` and let consumers re-export it directly. Config schemas must validate synchronously.

`defineState` is automatically scoped to the extension package, so the same state name does not collide with the consumer or another extension.

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

`eve extension build` writes an agent-shaped `dist/extension` tree, copies skill assets, emits declarations, and records compatibility metadata. It also manages the package exports for the mount factory (`@acme/crm`) and tool definitions (`@acme/crm/tools`). Publish `dist/`; consumers do not need the author's TypeScript source.

The exact `eve` development pin controls the extension authoring API and build tooling. The wildcard peer lets the consumer provide the runtime copy of eve. At consumption time, eve checks generated metadata, not the npm peer range. Do not add eve to regular `dependencies`.

Put runtime packages such as `zod` or an SDK in `dependencies`. If a dependency cannot be bundled, such as a native addon, tell consumers to add it to `build.externalDependencies` in `agent.ts`.

Consumers can now add the built package to an agent. A workspace-only extension uses the same package contract but does not need to be published; see [Use an extension in a workspace](#use-an-extension-in-a-workspace).

## Consumer: install and mount an extension

A mount gives the extension's contributions a namespace. Updating the package updates the mounted extension; nothing is copied into the consumer's agent.

### Install the package

Install the extension with the package manager already used by the consumer's agent project. Fresh eve projects use pnpm:

```bash
pnpm add @acme/crm
```

### Mount it

Create a file under `agent/extensions/`. Its filename becomes the mount namespace. Call the extension's default export when it needs configuration:

```ts title="agent/extensions/crm.ts"
import crm from "@acme/crm";

export default crm({ apiKey: process.env.CRM_API_KEY! });
```

Set `CRM_API_KEY` in the consumer's environment, such as `.env.local` for local development.

The mount adds `crm__` to named contributions: `tools/search.ts` becomes `crm__search`, and `connections/api.ts` becomes `crm__api`.

For an extension with no configuration, mount its default export directly:

```ts title="agent/extensions/gizmo.ts"
export { default } from "@acme/gizmo";
```

The same mount shape works with an npm package, a workspace dependency, or a linked local package.

### Use an extension in a workspace

A workspace extension is a regular extension package kept in the same monorepo as its consumers. It is useful when several agents need the same capabilities, or when a private capability should evolve alongside the agents that use it.

For example, a pnpm workspace can keep one extension next to two independently deployable agents:

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

You can scaffold the extension from a directory already covered by the workspace configuration:

```bash
cd packages
npx eve@latest extension init shared-capabilities
```

Give the generated package the name consumers will import. Add `"private": true` if it should never be published:

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

Each consuming agent declares its own workspace dependency:

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

The mount is intentionally per agent. Each consumer chooses its own mount namespace and, for a configured extension, passes its own configuration. For example, `shared.ts` contributes `shared__search`, while mounting the same package as `company.ts` in another agent contributes `company__search`.

#### Develop from source

When `eve dev` starts a consuming agent, it builds mounted, source-backed extensions found inside the same workspace before compiling the agent. It watches the extension source and relevant package and TypeScript configuration, then rebuilds only the affected extension. If an extension edit fails to build, the previous successful development generation keeps running.

Production `eve build` expects the extension distribution to exist already. Keep `eve extension build` in the extension package's `build` and `prepare` scripts, as the scaffold does, and run workspace builds in dependency order so extensions build before their consuming agents.

### Override a contribution

Use a directory mount to replace or remove an extension contribution. Put the mount declaration in `extension.ts` and add overrides beside it:

```
agent/extensions/crm/
  extension.ts
  tools/search.ts
```

```ts title="agent/extensions/crm/extension.ts"
import crm from "@acme/crm";

export default crm({ apiKey: process.env.CRM_API_KEY! });
```

A same-named consumer tool, connection, or skill wins. To adjust an extension tool, import it from the package's `./tools` export and define it again:

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

Hooks and instruction fragments are additive, so they cannot be replaced. To replace a dynamic tool, use a dynamic definition in the same slot; dynamic tools win over same-named static tools at runtime. `disableTool()` removes either kind.

The `crm__` prefix is reserved for this directory mount. A consumer cannot override the extension from `agent/tools/`, `agent/connections/`, or another agent-root slot.

### Use an extension tool result in a hook

To retain an extension tool's result type in a consumer hook, import its definition from `./tools` and pass it to [`toolResultFrom`](/guides/hooks#narrowing-tool-results):

```ts title="agent/hooks/narrow-crm.ts"
import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import { search } from "@acme/crm/tools";

export default defineHook({
  events: {
    "action.result"(event) {
      const match = toolResultFrom(event.data.result, search);
      if (match) console.log(match.output);
    },
  },
});
```

`toolResultFrom` recognizes the mounted `crm__search` result from the original definition, not the namespaced string. Publishers should keep tool descriptions distinct so eve can assign each definition an unambiguous identity.

### Compatibility

At build time, eve checks the extension's generated capability metadata. If the extension needs an unsupported capability contract, upgrade eve or install a compatible extension release.

## What to read next

- [Tools](/docs/tools): static tools, approval, and tool output
- [Dynamic capabilities](/docs/guides/dynamic-capabilities): dynamic tools, skills, and instructions
- [Instructions](/docs/instructions): static and TypeScript instructions
- [Skills](/docs/skills): package procedures and supporting files
- [Connections](/docs/connections): integrate external services
- [Hooks](/docs/guides/hooks): observe agent events
