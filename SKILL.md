---
name: eve
description: Build durable backend AI agents with the eve framework. Use when creating, editing, or debugging an eve project — agent instructions, skills, tools, connections, channels, sandboxes, subagents, schedules, or evals.
---

# eve

eve is a filesystem-first framework for durable backend AI agents. An agent is
a directory on disk — instructions, skills, tools, connections, channels,
subagents, and schedules are all files — and eve compiles and runs it.

## Source of truth

The complete documentation ships inside the `eve` package. Do not rely on this
skill for guidance — always read the bundled docs, which match the installed
version exactly:

```
node_modules/eve/docs/
```

Start with `node_modules/eve/docs/README.md`. It contains the full
index and recommended reading order. Before writing any eve code, read the
relevant guide there first.

If `eve` is not installed yet, install it (`npm install eve`) or scaffold a new
agent with `npx eve init <agent-name>`, then read the bundled docs.

Eve compiles authored transitive imports into its cache, but it does not copy
runtime assets that a dependency locates with `import.meta.dirname`. For an
asset-bearing dependency, use `build.externalDependencies` or change the
dependency to a bundle-safe asset import; otherwise discovery can pass while
the cached runtime fails with `ENOENT`.

`localDev()` trusts loopback requests. If a production ingress or Lambda Web
Adapter gateway reverse-proxies into Eve over `localhost` or `127.0.0.1`, omit
`localDev()` from the production auth chain; otherwise an invalid or missing
real credential can fall through to the synthetic local principal.

The default local workflow world persists under `.workflow-data/` in the Eve
app root. Ignore that directory before running local sessions so durable smoke
state does not enter the repository.

Exercise the runtime graph with `eve dev`; `eve info` and `eve build` can pass
even when an authored `disableTool()` targets a reserved tool such as `agent`,
which fails only when the live runtime resolves framework tools.

In a nested pnpm-workspace Eve app, declare the same `nitro` version Eve uses as
a direct app dependency. Live authored-tool bundling resolves
`nitro/package.json` from the app's generated `.eve/nitro` entrypoint and can
fail even though discovery, type-checking, and `eve build` pass.

Microsandbox runs authored `bootstrap()` commands as the unprivileged
`vercel-sandbox` user. Bake OS packages into the configured OCI image; do not
use `apt-get` or write root-owned paths during bootstrap. Include the bootstrap
exit code and a bounded stdout/stderr tail in thrown diagnostics so image and
permission failures are actionable.
