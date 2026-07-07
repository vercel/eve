---
title: "Extensions"
description: "Package tools, connections, skills, hooks, and schedules as a reusable npm package and mount it into an agent with one file."
---

An extension packages eve concepts — tools, connections, skills, instructions, hooks, schedules — as a reusable npm or local package. You author it as an agent-shaped directory, and a consumer mounts it under `agent/extensions/` — a single file for the common case, or a directory when it needs overrides. The consumer's build composes the extension's contributions into the agent under a namespace derived from the mount name. Nothing is copied; upgrades come through the package manager.

## Authoring

An extension is an agent-shaped directory without `agent.ts` or `sandbox` — those belong to the consuming agent. Every other slot works the same as inside an agent, with names derived from paths.

```
@acme/crm/
  package.json
  ext/
    extension.ts         # declares the extension (and its config, if any)
    lib/http.ts          # shared code, imported by your tools/hooks
    tools/search.ts
    connections/api.ts
    skills/triage/SKILL.md
    hooks/audit.ts
```

Shared code lives in `ext/lib/` and is imported by relative path — an extension bundles its own modules, so tools and hooks can share helpers instead of repeating them (`import { fetchJson } from "../lib/http.js"`).

A tool is identical to one authored inside an agent:

```ts title="ext/tools/search.ts"
import { defineTool } from "eve/tools";

import extension from "../extension.js";

export default defineTool({
  description: "Search the CRM.",
  inputSchema: {
    /* ... */
  },
  async execute({ query }) {
    const { apiKey } = extension.config;
    /* ... */
  },
});
```

Name tools and connections for what they do (`search`, not `crm_search`); the consumer's mount name supplies the namespace.

### Configuration

Every extension declares itself in `ext/extension.ts` with `defineExtension`. Its default export is the mount factory the consumer calls. To take consumer settings, pass a `config` schema — any [Standard Schema](https://standardschema.dev) (a Zod object here), the same kind of schema a tool's `inputSchema` uses:

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

**Config is optional** — an extension with no settings declares `defineExtension()` with no schema.

Read the bound config off the handle from any tool, hook, or connection. Import the declaration with a relative path (`../extension.js`, from a slot one level down) and read `.config` — typed straight from the schema, no type argument:

```ts title="ext/tools/search.ts"
import extension from "../extension.js";

// inside execute():
const { apiKey, baseUrl } = extension.config; // baseUrl falls back to its default
```

`.config` returns the consumer-supplied values validated against the schema with declared defaults applied. It is bound once when the extension mounts and constant for the session; values that vary per caller belong in connection auth. Because config is validated by a Standard Schema, an async-validating schema is rejected at mount.

### State

`defineState` names are prefixed with the extension's package namespace automatically, so an extension's durable state never collides with the consumer's or another extension's. Author it exactly as in an agent — `defineState("budget", …)` — and eve scopes the key. State is keyed to the package (not the mount name), so renaming the mount never orphans persisted state. The scope is baked in at build time, so it holds no matter how the consumer imports the extension's modules — including an override that eagerly imports the extension's tools barrel.

## Publishing

Point `eve.extension` at the source directory and run `eve build`. Wire `package.json` once:

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

`eve build` emits the mount factory (`dist/index.mjs`, re-exporting the `defineExtension` handle as `default` and the extension's short name) and named tool exports for consumer overrides (`dist/tools/index.mjs`), then fills those two entries into the package's `exports` map (`.` and `./tools`) — so you never hand-list them. It only adds missing entries, so a deliberately customized export is left alone. Local and workspace packages work without publishing.

### Dependencies

`eve` is a **peer** dependency — one eve lives in the consuming app, and the extension's `eve/*` imports resolve to it (the peer range is the compatibility contract). Everything else the extension imports at runtime (SDKs, `zod`, …) goes in `dependencies` and is installed into the consumer transitively; each extension resolves its own declared versions. Because the consumer recompiles the extension from source, `files` must include `ext/`, not just `dist/`.

How those deps reach the running app depends on the build. Under `eve dev` and `eve eval` they stay external and resolve from `node_modules` at runtime. In the hosted build (`eve build`) they are bundled into the deployable — except packages eve keeps external (native or heavy modules, plus any the consuming agent lists in `build.externalDependencies`), which are traced in as runtime dependencies instead. A dependency that can't be bundled — a native addon, say — must be listed in the **consuming agent's** `build.externalDependencies`; an extension can't declare build config, so call out any such dependency in your README.

## Mounting

Mount an extension under `agent/extensions/`. Use a single file for the common case, or a directory when you also want to [override](#overrides) some of its contributions. Either way the namespace is the file basename or the directory name.

A file mount is one file whose default export is the mounted extension:

```ts title="agent/extensions/crm.ts"
import { crm } from "@acme/crm";

export default crm({ apiKey: process.env.CRM_API_KEY });
```

An extension that takes no config needs no factory call — mount it with a bare re-export:

```ts title="agent/extensions/gizmo.ts"
export { default } from "@acme/gizmo";
```

The build resolves the package from the import, composes its contributions into the agent, and namespaces them by the mount name: the `search` tool becomes `crm__search`, the `api` connection becomes `crm__api`. Instruction fragments append after the agent's own instructions.

### Overrides

To override some of a mounted extension's contributions, author the mount as a **directory**. The mount declaration moves into `extension.ts` — the same content the flat file would hold — and override slots sit alongside it, exactly as in an agent:

```
agent/extensions/crm/
  extension.ts         # export default crm({ apiKey: process.env.CRM_API_KEY })
  tools/search.ts      # composes as crm__search, shadowing the extension's own
  connections/api.ts   # composes as crm__api
```

A file in an override slot composes under the same `crm__` namespace and wins on name collision — `tools/search.ts` becomes `crm__search` and shadows the extension's own `search`. Name the file for the composed contribution's bare name (`search`, not `crm__search`); the mount directory supplies the prefix.

Overrides only work here, inside the mount directory. The `crm__` prefix is reserved: an agent-root contribution named `crm__…` (e.g. `agent/tools/crm__search.ts`) is a build error, so an extension's contributions can't be shadowed from outside its mount.

To reuse the extension's definition and change one field, import the base from the extension and re-define it:

```ts title="agent/extensions/crm/tools/search.ts"
import { search } from "@acme/crm/tools";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";

export default defineTool({ ...search, approval: always() });
```

## Limits

Per-session limits (token budgets, subagent depth) are the consuming agent's to own and are enforced on the session, so an extension's tools and schedules run within them. An extension cannot declare limits, a sandbox, or agent config.

An extension also cannot mount other extensions — an `extensions/` slot inside an extension is a build error. Only a consuming agent mounts extensions; nesting is reserved for a future release.
