---
title: "Extensions"
description: "Package tools, connections, skills, and hooks as a reusable package and mount it into an agent."
---

An extension packages eve capabilities — tools, connections, skills, instructions, hooks — as a reusable npm or local package. You author it as an agent-shaped directory; a consuming agent mounts it under `agent/extensions/`, and its contributions compose into the agent under a namespace. Nothing is copied — upgrades come through the package manager.

## Authoring

Start from a scaffold:

```bash
npx eve@latest extension init my-crm
```

This creates the package, installs dependencies, and initializes Git. You get `extension/extension.ts`, TypeScript config, and a `package.json` ready to publish or mount. Add tools, skills, hooks, and connections under `extension/` yourself.

An extension is an agent-shaped directory without `agent.ts` or `sandbox` (those belong to the consuming agent). Every slot works as it does in an agent, with names derived from paths.

```
@acme/crm/
  package.json
  extension/
    extension.ts        # the extension declaration — see Configuration
    tools/search.ts
    connections/api.ts
    skills/triage/SKILL.md
    hooks/audit.ts
    lib/http.ts         # shared helpers, imported as ../lib/http
```

Name tools and connections for what they do (`search`, not `crm_search`) — the mount supplies the namespace. Shared code goes in `extension/lib/`, imported by relative path — eve compiles the source, so relative imports need no `.js` extension.

### Configuration

Declare the extension in `extension/extension.ts` with `defineExtension`; its default export is the mount factory a consumer calls. Pass `config` — any [Standard Schema](https://standardschema.dev) (a Zod object here), like a tool's `inputSchema` — to accept consumer settings:

```ts title="extension/extension.ts"
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

```ts title="extension/tools/search.ts"
import { defineTool } from "eve/tools";

import extension from "../extension";

export default defineTool({
  description: "Search the CRM.",
  inputSchema: {/* ... */},
  async execute({ query }) {
    const { apiKey, baseUrl } = extension.config; // validated, defaults applied
  },
});
```

Config is bound once when the consumer mounts the extension and stays constant for the session; per-request values belong in connection auth instead.

### State

`defineState` is scoped to the extension's package automatically, so identically-named state never collides with the consuming agent or another extension. Author it exactly as in an agent — `defineState("budget", …)`.

## Publishing

Declare separate authoring and distribution roots and run `eve extension build` (wired to `build`/`prepare`):

```jsonc title="package.json"
{
  "name": "@acme/crm",
  "type": "module",
  "eve": {
    "extension": {
      "source": "./extension",
      "dist": "./dist/extension",
    },
  },
  "files": ["dist"],
  "peerDependencies": { "eve": "*" },
  "devDependencies": { "eve": "^x", "typescript": "^x" },
  "dependencies": { "zod": "^3" },
  "scripts": { "build": "eve extension build", "prepare": "eve extension build" },
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
  "include": ["extension/**/*.ts"],
}
```

`eve extension build` transforms every JavaScript or TypeScript module into an agent-shaped `dist/extension` tree, copies skill packages and their assets, emits type declarations, and writes `dist/extension/_manifest.json`. The generated package entrypoints (`dist/index.mjs` and `dist/tools/index.mjs`) re-export those same dist modules, and the build fills the `exports` map so you never hand-list it. The published package therefore needs `dist/`, not the author's original TypeScript. Consumers read only `eve.extension.dist`, so a published package may omit `eve.extension.source`; keep `source` declared wherever `eve extension build` runs.

The build uses the package `tsconfig.json` when it emits declarations. Its `include` must cover every JavaScript or TypeScript module in the extension source (and JavaScript modules require `allowJs`); the build fails before publishing if any distributed module would be missing its declaration.

The manifest contains only its format, the diagnostic eve build version, and the versions of extension capabilities this package actually uses. It does not contain compiled tools, schemas, names, or executable definitions; the consuming eve still discovers and normalizes the agent-shaped dist tree.

### Workspace development

During local development, `eve dev` automatically rebuilds mounted workspace extensions when their source changes.

### Dependencies

`eve` is a required wildcard **peer** dependency: one eve lives in the consuming app and the extension's `eve/*` imports resolve to it. The extension's concrete eve version belongs in `devDependencies` for authoring types and build tooling. npm peer semver does not decide extension compatibility; eve validates the generated per-capability requirements. Do not mark the eve peer optional and do not add eve to regular `dependencies`.

Everything else the extension imports at execution time (SDKs, `zod`, …) goes in `dependencies`; each extension resolves its own versions. Build-only and test-only packages go in `devDependencies`.

Those deps resolve from `node_modules` under `eve dev`/`eve eval` and are bundled into the deployable by the consuming agent's `eve build`. A dependency that can't be bundled (a native addon) must be listed in the **consuming agent's** `build.externalDependencies` — an extension can't declare build config, so note it in your README.

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

### Typed tool results

A consuming agent can narrow a mounted extension's tool result in a hook: import the tool from the extension's `./tools` export and pass it to [`toolResultFrom`](/guides/hooks#narrowing-tool-results). It matches the namespaced result (`crm__search`) because identity keys off the tool definition, not its name.

```ts title="agent/hooks/narrow-crm.ts"
import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import { search } from "@acme/crm/tools";

export default defineHook({
  events: {
    "action.result"(event) {
      const match = toolResultFrom(event.data.result, search);
      if (match) console.log(match.output); // typed as search's output
    },
  },
});
```

Matching keys off the tool's description, so keep extension tool descriptions distinct — one shared with another tool makes the identity ambiguous and `toolResultFrom` stops matching.

## Limits

An extension cannot declare a `sandbox`, agent config, schedules, or limits, and cannot mount other extensions — those are the consuming agent's to own (background scheduling, for instance, runs on the agent's deployment under its limits). An extension's tools run within the consuming agent's per-session limits.
