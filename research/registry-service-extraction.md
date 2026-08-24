---
issue: TBD
status: proposed
last_updated: "2026-08-21"
---

# Registry service extraction

## Goal

Make the existing registry commands equally useful to humans and agents while
removing duplicated registry behavior from the CLI, dev TUI, and
`@eve/self-modification`.

The supported public interface remains the command surface:

```sh
eve registry list --json
eve registry search <query> --json
eve registry view <item> --json
eve add <item> --non-interactive
```

An agent with project command access should invoke these commands just as a
human does. A constrained agent without host command access can request the same
operation through a host capability, but that capability should adapt the
existing command behavior rather than introduce a second registry API.

The extraction in this proposal is therefore internal. It does not add an
`eve/registry` package export or a public TypeScript mutation API. A future
production executor may reveal a need for one, but the command interface should
be tried first and any new API should be designed with that concrete executor.

The initial self-modification flow does not depend on this extraction. It can
search the official index and ask the developer to run `/add <address>` or
`eve add <address>` manually. See
[`selfmod-development-setup-actions.md`](./selfmod-development-setup-actions.md).

## Current architecture

Most registry behavior lives in
`packages/eve/src/cli/commands/registry.ts`. It combines:

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
aggregation, project preparation, and deployment follow-up. A separate
self-modification catalog parser would duplicate the first three
responsibilities.

## Thin wrapper over shadcn registries

eve uses the shadcn registry protocol and vendored client. The client already
provides the core address-oriented operations:

```ts
searchRegistries(sources, options);
getRegistryItems(addresses, options);
addRegistryItems(addresses, options);
```

The extracted code should remain a thin eve-specific wrapper around those
operations. eve needs to add only the behavior the generic client cannot know:

- built-in and project registry configuration;
- official-source classification;
- eve metadata, version requirements, and package components;
- official-only setup eligibility;
- project preparation required by eve items; and
- adaptation to CLI, TUI, and agent interaction.

Do not introduce a generic registry provider interface, a parallel manifest
model, a serializable installation plan, a transaction layer, or an eve-owned
installer without a demonstrated requirement. Vendored shadcn types remain
behind the internal boundary, but eve-owned internal types should normalize
only the fields its callers actually use.

`addRegistryItems` means “install these addressed items into a project”; it does
not publish an item to a registry and is not a proposed public eve API.

## Shared internal boundary

Extract the smallest helpers needed to give every adapter the same behavior:

- resolve official, configured, skills, and direct-URL addresses;
- search registries and normalize partial source failures;
- load manifests and interpret eve-specific metadata;
- select and expand package components;
- enforce eve version and setup trust rules; and
- install through the vendored client.

Keep interaction at the edges:

- `eve registry` owns command arguments and human or JSON presentation;
- `eve add` owns flags, prompts, NDJSON, and exit codes;
- `/add` owns browsing, confirmation, exclusive terminal use, host refresh,
  add-more behavior, and deployment follow-up; and
- a development agent executor owns capability checks, request correlation,
  mandatory approval, mutation locking, and model resumption.

Internal extraction is justified only where two adapters otherwise implement
the same registry semantics. Do not reshape working CLI code merely to produce
a service-shaped layer.

## Human and agent command parity

The registry CLI is the machine interface as well as the human interface.
Machine-readable modes must cover the same useful operations:

- list and search return bounded structured results and per-source failures;
- view returns the resolved item needed to make an installation decision;
- add runs without interactive prompts under `--non-interactive` and reports a
  stable terminal outcome, including missing answers or prerequisites; and
- exit codes distinguish success, failure, and required input.

The agent documentation should teach this sequence rather than a package API:

```sh
eve registry search browser --json
eve registry view extension/agent-browser --json
eve add extension/agent-browser --non-interactive
```

This keeps discovery and installation coverage aligned: improvements to the
commands benefit both humans and agents, and agents do not need a private parser
or a separately maintained set of registry tools.

`@eve/self-modification` runs in a deliberately constrained sandbox, so it may
not always have permission to execute the project CLI. In that environment it
either returns the exact command for the developer or submits a constrained
host request representing the same registry operation. The package does not
need to import private CLI modules or a new `eve/registry` export.

## Source and trust rules

Source identity is an internal security and presentation concern, not a claim
about who authored an integration's npm package. Items in eve's catalog may
integrate third-party products while still being official-source items.

Preserve the current rules:

- relative official addresses resolve through eve's trusted official source;
- configured namespaces resolve through project registry configuration;
- direct URLs remain visibly non-official;
- configured headers and URL parameters never appear in output, model context,
  errors, or durable events; and
- only manifests resolved from eve's trusted official source may declare
  executable eve setup behavior or registry packages.

Human and JSON output need only enough safe source information to explain where
an item came from. This proposal does not introduce a public source identity
type.

## Development agent-initiated add

An agent with ordinary project shell authority can run
`eve add <item> --non-interactive` directly. The special development flow is for
a constrained agent that can request an add but cannot mutate the host project
or approve its own request.

The intended flow is:

1. The model requests the semantic equivalent of `eve add <address>` through a
   local capability.
2. The harness accepts it only for a connected development session and records
   a correlated pending request.
3. The TUI resolves and displays the item through the same internal operations
   used by `eve registry view` and `/add`.
4. The TUI obtains approval that the model cannot answer. Initial releases
   require approval for every item.
5. On approval, the TUI acquires the existing project-mutation boundary and
   executes the same installation and setup behavior as `eve add`/`/add`, then
   refreshes the development host and settles the tool call.
6. Rejection or cancellation settles the request without beginning
   installation.

This capability is a transport and approval adapter for the command operation,
not a new general registry tool. It must not accept arbitrary commands, host
paths, or package-manager arguments. Clients without the capability retain the
manual `/add <address>` or `eve add <address>` handoff.

The development flow should preserve the same installation semantics and
limitations as an equivalent human invocation, including non-transactional
partial failure. Stronger content-integrity, rollback, or sandbox policy should
not be added solely as part of this extraction.

## Future production flow

A production executor would run against an isolated proposal checkout without a
connected TUI. Start by evaluating whether the existing machine-oriented
commands can provide the required behavior: structured discovery,
noninteractive installation with setup skipped, useful exit outcomes, and a
diff that the executor validates independently.

Only add a public `eve/registry` TypeScript API if the production design exposes
a concrete requirement that the CLI cannot satisfy, such as retaining resolved
content across a durable approval boundary. Production authorization,
sandboxing, egress, integrity, lifecycle-script policy, rollback, and pull
request publication belong to that future design.

## Validation

- Characterize official, configured, skills, and direct-URL behavior before
  moving shared helpers.
- Cover JSON list, search, and view output as agent-facing command contracts.
- Cover noninteractive add success, required input, continuation, cancellation,
  and failure outcomes.
- Preserve package component, eve version, official-only setup, and TUI
  confirmation behavior.
- Add development action coverage proving that the model cannot approve its own
  request and that approval reaches the same add implementation.

## Completion criteria

This extraction is complete when:

- humans and agents use the same documented registry command surface;
- registry source, search, manifest, and installation semantics are not
  reimplemented by each adapter;
- `eve registry`, `eve add`, and `/add` preserve their existing behavior;
- constrained self-modification uses a command handoff or host adapter instead
  of a private catalog parser;
- the internal layer remains a thin wrapper over the vendored shadcn client; and
- no public TypeScript registry API or additional installation abstraction is
  introduced without a concrete caller.
