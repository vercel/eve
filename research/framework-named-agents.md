---
issue: https://github.com/vercel/eve/issues/4210
status: proposed
last_updated: "2026-10-23"
---

# Named agents in eve/nuxt and eve/sveltekit

## Problem and dependencies

`eve/next` mounts named agents under `/eve/<name>/v1/*` from an explicit
`agents` map or a discovered `agents/` workspace. The browser bindings select
those routes with `agent: "support"`; selecting a route does not mount it.
Nuxt and SvelteKit lack Next's explicit `agents` and `servicePrefix` options.

This is a proposal, not an implementation of parity. Two open PRs affect its
scope:

- [#3690](https://github.com/vercel/eve/pull/3690) adds automatic workspace
  discovery and named mounts to Nuxt and SvelteKit. If it lands first, reuse
  its resolver and workspace routing; do not describe those integrations as
  single-agent-only. Explicit maps and service-prefix overrides remain
  separate parity work.
- [#5327](https://github.com/vercel/eve/pull/5327), for
  [#4211](https://github.com/vercel/eve/issues/4211), proposes SvelteKit's
  `createEveHandle()` production forwarding hook. It is unmerged and is a
  prerequisite for the self-hosted SvelteKit work below. No such hook exists
  on the current base.

## Proposed authoring API

Use Next's option names and precedence:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["eve/nuxt"],
  eve: {
    agents: {
      billing: "../agents/billing",
      support: {
        root: "../agents/support",
        buildCommand: "pnpm build:eve",
        servicePrefix: "/_eve_internal/support",
      },
    },
  },
});
```

```ts
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import { eveSvelteKit } from "eve/sveltekit";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [eveSvelteKit({ agents: { billing: "../agents/billing" } }), sveltekit()],
});
```

- A named agent serves `/eve/<name>/v1/**`; the unnamed single-agent form
  retains `/eve/v1/**`.
- When `agents` is unset, discover a workspace at `eveRoot ?? hostRoot`.
  Mount its members by directory name; otherwise retain the unnamed form.
  Resolve relative roots against the host app root.
- `agents` and `eveRoot` are mutually exclusive. Reject empty maps and invalid
  public agent names with the same validation as Next.
- Per-agent `buildCommand` overrides integration-wide `eveBuildCommand`,
  which overrides the generated eve build command.
- Expose integration-wide `servicePrefix` and per-agent overrides. Append
  `/<name>` to the integration-wide prefix for named agents without an
  override. The base defaults to `/_eve_internal/eve`; preserve Next's
  normalization and rejection of a root-only prefix.
- Use object-entry order for explicit maps. Workspace discovery sorts members
  by directory name with the existing `localeCompare` ordering. Assign port
  offsets from the resulting list, not filesystem enumeration order.

## Current ownership and proposed boundary

On the current base, Next resolves agents in `public/next/index.ts`, uses the
shared dev-server manager, and emits Vercel output through
`public/next/vercel-output-config.ts` and
`internal/vercel/assemble-eve-services.ts`. Nuxt uses
`shared/framework-eve-server.ts`. SvelteKit instead owns a separate manager in
`public/sveltekit/dev-server.ts`. Nuxt, SvelteKit, and TanStack use
`shared/vercel-services.ts`, whose current contract emits one fixed
`/eve/v1` service. SvelteKit configures Vite dev/preview proxies and merges
Vercel output; it does not currently install a production `handle` hook.

The shared resolver returns data, not host routing or process handles:

```text
Next / Nuxt / SvelteKit -> shared/framework-agents.ts
                          -> name, root, workspace membership, public prefix,
                             service prefix, port offset, build command
Each host adapter      -> its own proxy/rewrites, lifecycle, output merge
```

Extract Next's resolution into that boundary, or extend #3690's resolver if
available. Keep each adapter's lifecycle and output merge. Unifying the dev
server managers is out of scope; pass the resolved member selection to each
manager and spawn workspace members with `--agent <name>`.

Extend the Nuxt/SvelteKit Vercel helper to consume resolved targets and reuse
`assembleEveVercelServices`, rather than duplicating Next's emitter. Reuse
`createEveServiceName`: `eve` for unnamed agents, `eve-<name>` when valid, and
its existing sanitized/hash form otherwise. Reject duplicate resolved service
names or prefixes before writing output; never overwrite an unrelated host
service. Hand-maintained `vercel.json` services must match every resolved
agent, with operator-owned routing, rather than silently generating missing
services. Keep TanStack's existing single-target call contract.

## Routing contract by environment

The following mappings are proposed for Nuxt and SvelteKit. Here `name` is a
resolved agent name, `path` is a transport suffix such as `session`, and
`servicePrefix` is that agent's private namespace. Unnamed routes keep their
existing mapping.

| Environment                         | Public route            | Upstream route and owner                                                                                                                                                   |
| ----------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Development (and SvelteKit preview) | `/eve/<name>/v1/<path>` | Nuxt route rules or the SvelteKit Vite proxy select the member's dev server and rewrite to `/eve/v1/<path>`. Strip the named mount; do not pass the public path unchanged. |
| Generated Vercel output             | `/eve/<name>/v1/<path>` | The host output selects the member service before filesystem routing. The service applies the existing `request.path` transform to `/eve/v1/<path>`, as Next does.         |
| Self-hosted, local ports            | `/eve/<name>/v1/<path>` | Nuxt route rules or SvelteKit's proposed handle select `basePort + offset` and rewrite to `/eve/v1/<path>`.                                                                |
| Self-hosted, configured origin      | `/eve/<name>/v1/<path>` | Forward to `<origin><servicePrefix>/eve/v1/<path>`. The operator's reverse proxy strips the private service prefix before reaching the member's `/eve/v1/<path>`.          |

Preserve each host's production origin/port variable names. Nuxt's proxy
destination is fixed at build time; the proposed SvelteKit handle resolves
its production target at runtime. Extend #5327's hook to accept the same
agent selection configuration as the Vite plugin. Compose it with the app's
own `handle` using SvelteKit's `sequence`; do not overwrite application auth
or other hooks. Starting self-hosted member processes remains the operator's
job, unlike Next's automatic local production startup.

Path rewriting and public URL generation are separate. Set each member's
`EVE_PUBLIC_ROUTE_PREFIX=/eve/<name>` in its build/runtime environment so
callbacks and generated URLs retain the public mount, even though its
transport receives `/eve/v1/**`. Generated Vercel services already do this
in Next; extend that behavior to Nuxt/SvelteKit. For self-hosting, document
`WORKFLOW_LOCAL_BASE_URL`, forwarding workflow callbacks as well as eve
routes, and consistent public prefixes as in
[workspace operations](../docs/guides/deployment/self-hosted-operations.md#run-workspace-members).
Do not rely on `EVE_PUBLIC_ROUTE_PREFIX` to replace the proxy rewrite.

## Scope and validation

No browser binding or eve protocol changes are proposed. TanStack parity is
out of scope. This PR changes documentation and the plan only; implementation
requires its own public API review, changeset, and behavioral coverage.

For that implementation:

- Unit tests cover explicit-map validation, option precedence, port offsets,
  route rewrites, and preservation of each host's existing routes.
- Focused integration tests cover workspace discovery at the host root and
  `eveRoot`, per-agent Vercel output, and service collisions. Preserve Next's
  existing behavior while extracting resolution.
- Framework fixtures prove named requests reach the selected member in Nuxt
  and SvelteKit, including self-hosted SvelteKit forwarding composed with app
  hooks. Use CI for the full fixture builds and fixture-owned evals.
- Update the guides for explicit maps and service prefixes without removing
  automatic workspace instructions introduced by #3690.
