---
issue: TBD
status: proposed
last_updated: "2026-08-21"
---

# Registry service extraction

## Goal

Give registry discovery one eve-owned implementation that can be reused by:

- `eve registry list/search/view`;
- `eve add`;
- the dev TUI's `/add` flow; and
- `@eve/self-modification` discovery.

The immediate public need is read-only discovery. `@eve/self-modification` is a
separately published package, so it needs a narrow `eve/registry` entrypoint
rather than a private CLI import or its own parser for the official index.

Installation remains an internal eve capability in this phase. The CLI, TUI,
and a development-mode agent action can share it without publishing a general
project-mutation API. A production self-modification executor may create a need
for a public mutation API later, but that API should be designed with the
production executor rather than anticipated here.

This extraction is not required for the initial guided self-modification
handoff. Until it lands, self-modification can search the official index and ask
the developer to type `/add <address>` manually. See
[`selfmod-development-setup-actions.md`](./selfmod-development-setup-actions.md).

## Current architecture

Most registry behavior lives in
`packages/eve/src/cli/commands/registry.ts`. Despite exporting TypeScript
functions within the repository, that module is private because no `eve`
package export reaches it.

The module currently combines:

1. address and source resolution for the official registry, configured
   namespaces, direct URLs, the built-in skills registry, and the development
   official-registry override;
2. multi-registry search, partial errors, metadata enrichment, sorting, and
   limits;
3. manifest interpretation, component selection, eve version requirements, and
   setup metadata;
4. project mutation through the vendored shadcn registry client; and
5. CLI-specific prompting, logging, NDJSON, terminal detection, and exit state.

The setup flow and package helpers add TUI rendering, confirmation, setup fact
aggregation, project preparation, and deployment follow-up.

The vendored registry client currently exposes address-oriented operations:

```ts
searchRegistries(sources, options);
getRegistryItems(addresses, options);
addRegistryItems(addresses, options);
```

These are internal implementation details and must not be re-exported from
`eve/registry`. In particular, `addRegistryItems` means “install these addressed
items into a project”; it does not publish an item to a registry.

## Proposed boundary

### Public `eve/registry` API

The initial public API is read-only and serves the concrete cross-package use
case:

```ts
import { searchRegistryItems } from "eve/registry";

const result = await searchRegistryItems({
  appRoot,
  query: "browser",
  category: "extension",
  limit: 10,
  signal,
});
```

The exact names can be finalized during implementation, but the entrypoint
should expose an eve-owned result containing only the fields discovery needs:
canonical address, title, description, category, and package component
summaries. It must not expose vendored shadcn types, raw manifests, configured
headers or parameters, CLI logging, terminal state, or mutable process state.

The self-modification caller searches the official registry only. Internally,
the same search implementation also supports the configured and URL sources
needed by existing CLI and TUI behavior. Public support for selecting arbitrary
sources should be added only when an external caller needs it.

Search remains bounded, preserves partial results when one source fails, and
validates malformed catalog entries at the boundary. Category matching includes
package components so that a package can match a channel or extension search.

### Internal registry operations

Internal modules own the shared behavior needed to:

- read registry configuration and compose built-in sources;
- resolve canonical addresses without confusing configured or URL sources with
  eve's official source;
- search catalogs and normalize partial failures;
- load and validate manifests and package components;
- inspect the files, dependencies, environment variable names, and setup
  declared by an item; and
- install an inspected item and run eligible setup through an explicit caller
  policy.

Callers continue to own interaction and authorization concerns:

- the CLI owns flags, prompts, logging, NDJSON, and exit codes;
- `/add` owns browsing, confirmation, exclusive terminal use, host refresh,
  add-more behavior, and deployment follow-up;
- the development agent-action executor owns capability checks, request
  correlation, HITL approval, project-mutation locking, and model resumption;
- all callers choose the application root and authorize mutation before
  installation.

The shared implementation may use an internal inspect/apply split because a UI
must show an item before installing it. That split is not a public API
commitment.

## Source and trust rules

Source identity is an internal security and presentation concern, not a claim
about who authored an integration's npm package. Items in eve's catalog may
integrate third-party products while still being official-source items.

Preserve these existing rules:

- relative official addresses resolve through eve's trusted official source;
- configured namespaces resolve through project registry configuration;
- direct URLs remain visibly non-official;
- configured headers and URL parameters never appear in results, model context,
  errors, or durable events; and
- only manifests resolved from eve's trusted official source may declare
  executable eve setup behavior or registry packages.

CLI and TUI presentation still needs a safe source label so developers can see
what they are about to install. The initial public self-modification search does
not need a general `RegistrySourceSummary` union because it is official-only.

## Development agent-initiated add

The first mutation use case outside the existing commands is development mode,
where an agent asks the connected eve host to add a known registry address. The
agent must not receive a filesystem mutation API or call the vendored installer
directly.

The intended flow is:

1. The model invokes a framework-owned add action with a registry address.
2. The harness accepts it only when the session advertises a local registry-add
   capability and records a correlated pending request.
3. The TUI resolves and inspects the item through the internal registry
   implementation.
4. The TUI shows the source and expected effects and obtains confirmation that
   the model cannot answer. Initial releases should require approval for every
   item.
5. On approval, the TUI acquires the existing project-mutation boundary,
   installs through the same internal primitive as `/add`, runs any eligible
   interactive setup, refreshes the development host, and settles the pending
   tool call.
6. On rejection or cancellation, no installation begins and the tool call is
   settled with that outcome.

Clients without this capability retain the guided handoff: self-modification
returns an exact `/add <address>` command for the local TUI or an
`eve add <address>` command for the project terminal.

The inspected item and the installed item should be the same content. The
current vendored `addRegistryItems` operation resolves an address again, so it
cannot by itself guarantee this. Before enabling direct agent-initiated
installation, perform a focused spike to determine whether the vendored
boundary can apply already-resolved content. If not, keep the guided `/add`
handoff until eve owns the minimal installer seam required to preserve the
approval boundary. The serialization format, hashing scheme, closure limits,
and public plan shape are deliberately deferred.

Installation remains non-transactional, as `eve add` is today. Development
callers should report partial failure clearly and refresh or restart the host
from known state. Transactional installation is not part of this extraction.

## Completion criteria

This extraction is complete when:

- registry search and manifest semantics have one implementation;
- `eve registry`, `eve add`, and `/add` are adapters over shared internal
  operations;
- `@eve/self-modification` uses the public read-only entrypoint instead of
  parsing the official catalog itself;
- source credentials and vendored registry types cannot cross the public or
  model-facing boundary;
- setup remains restricted to trusted official-source items;
- the development action either installs the exact inspected content after HITL
  approval or remains on the guided `/add` fallback; and
- no public project-mutation API is introduced without a concrete external
  executor.
