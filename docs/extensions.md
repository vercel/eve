---
title: "Extensions"
description: "Package tools, connections, skills, and hooks as a reusable package and mount it into an agent."
---

An extension packages eve capabilities — tools, connections, skills, instructions, hooks — as a reusable npm or local package. You author it as an agent-shaped directory; a consuming agent mounts it under `agent/extensions/`, and its contributions compose into the agent under a namespace. Nothing is copied — upgrades come through the package manager.

## Authoring

An extension is an agent-shaped directory without `agent.ts` or `sandbox` (those belong to the consuming agent). Every slot works as it does in an agent, with names derived from paths.

```
@acme/crm/
  package.json
  ext/
    extension.ts        # the extension declaration — see Configuration
    tools/search.ts
    connections/api.ts
    skills/triage/SKILL.md
    hooks/audit.ts
    lib/http.ts         # shared helpers, imported as ../lib/http
```

Name tools and connections for what they do (`search`, not `crm_search`) — the mount supplies the namespace. Shared code goes in `ext/lib/`, imported by relative path — eve compiles the source, so relative imports need no `.js` extension.

### Configuration

Declare the extension in `ext/extension.ts` with `defineExtension`; its default export is the mount factory a consumer calls. Pass `config` — any [Standard Schema](https://standardschema.dev) (a Zod object here), like a tool's `inputSchema` — to accept consumer settings:

```ts title="ext/extension.ts"
import { defineExtension } from "eve/extension";
import { z } from "zod";

export default defineExtension({
  config: z.object({
    apiKey: z.string(),
    baseUrl: z.string().default("https://api.acme.example"),
  }),
});
```

Config is optional — `defineExtension()` with no schema. Read it off the handle, imported from the declaration; it's typed from the schema:

```ts title="ext/tools/search.ts"
import { defineTool } from "eve/tools";

import extension from "../extension";

export default defineTool({
  description: "Search the CRM.",
  inputSchema: {
    /* ... */
  },
  async execute({ query }) {
    const { apiKey, baseUrl } = extension.config; // validated, defaults applied
  },
});
```

Config is bound once when the consumer mounts the extension and stays constant for the session; per-request values belong in connection auth instead.

### State

`defineState` is scoped to the extension's package automatically, so identically-named state never collides with the consuming agent or another extension. Author it exactly as in an agent — `defineState("budget", …)`.

## Publishing

Point `eve.extension` at the source directory and run `eve build` (wired to `build`/`prepare`):

```jsonc title="package.json"
{
  "name": "@acme/crm",
  "type": "module",
  "eve": { "extension": "./ext" },
  "files": ["ext", "dist"],
  "peerDependencies": { "eve": "^x" },
  "dependencies": { "zod": "^3" },
  "scripts": { "build": "eve build", "prepare": "eve build" },
}
```

Author the source with `moduleResolution: "bundler"` — eve compiles it, so relative imports need no `.js` extension:

```jsonc title="tsconfig.json"
{
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "types": ["node"],
  },
  "include": ["ext/**/*.ts"],
}
```

`eve build` compiles the package's entry points to plain JavaScript with type declarations — the mount factory (`dist/index.mjs`) and the tool re-exports overrides use (`dist/tools`) — and fills the `exports` map so you never hand-list it. Compiling is what lets an installed extension load directly; local and workspace packages also work without publishing.

### Dependencies

`eve` is a **peer** dependency: one eve lives in the consuming app and the extension's `eve/*` imports resolve to it. Declare the eve versions your extension supports as the peer range (`"eve": "^1"`) — eve enforces it when the extension is mounted, failing the build with a clear error if the app's eve is out of range, rather than surfacing a confusing compile break. Everything else the extension imports (SDKs, `zod`, …) goes in `dependencies`; each extension resolves its own versions. The consumer recompiles the extension's contributions from source, so `files` must ship both `ext/` (that source) and `dist/` (the compiled entry points).

Those deps resolve from `node_modules` under `eve dev`/`eve eval` and are bundled into the deployable by `eve build`. A dependency that can't be bundled (a native addon) must be listed in the **consuming agent's** `build.externalDependencies` — an extension can't declare build config, so note it in your README.

## Mounting

A consuming agent mounts an extension under `agent/extensions/` — a single file, or a directory when it needs [overrides](#overrides). The namespace is the file basename or directory name; contributions compose as `<namespace>__<name>` (`crm__search`, `crm__api`).

```ts title="agent/extensions/crm.ts"
import crm from "@acme/crm";

export default crm({ apiKey: process.env.CRM_API_KEY });
```

A no-config extension takes no factory call — mount it with a bare re-export:

```ts title="agent/extensions/gizmo.ts"
export { default } from "@acme/gizmo";
```

### Overrides

To override a mounted extension's contributions, author the mount as a directory: the declaration in `extension.ts`, override slots alongside it.

```
agent/extensions/crm/
  extension.ts         # export default crm({ apiKey: process.env.CRM_API_KEY })
  tools/search.ts      # composes as crm__search, shadowing the extension's own
```

A file in an override slot composes under the mount namespace and wins on a name collision. Name it for the bare contribution name (`search`, not `crm__search`) — the directory supplies the prefix. To tweak the extension's own definition, import and re-define it:

```ts title="agent/extensions/crm/tools/search.ts"
import { search } from "@acme/crm/tools";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";

export default defineTool({ ...search, approval: always() });
```

Or drop it entirely by opting out of the slot with `disableTool()`:

```ts title="agent/extensions/crm/tools/search.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

An override targets one slot, matched by name and kind: a static file replaces the extension's static tool, a dynamic file replaces its dynamic resolver, and `disableTool()` removes whichever the extension put there. Because a dynamic tool wins over a same-named static one at runtime, replace or disable a dynamic tool through its own slot — a static file of the same name won't shadow it.

Overrides only work here — the `<namespace>__` prefix is reserved, so an agent-root contribution named `crm__…` is a build error and an extension can't be shadowed from outside its mount.

## Limits

An extension cannot declare a `sandbox`, agent config, schedules, or limits, and cannot mount other extensions — those are the consuming agent's to own (background scheduling, for instance, runs on the agent's deployment under its limits). An extension's tools run within the consuming agent's per-session limits.
