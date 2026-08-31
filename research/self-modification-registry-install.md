---
issue: https://github.com/vercel/eve/issues/742
status: proposed
last_updated: "2026-08-31"
---

# Self-modification: driving registry installs

## Proposal

The self-modification subagent can search the registry but cannot install from
it. Asked to "add a Slack channel", it finds `channel/slack` and then tells the
developer to type `/add channel/slack` themselves. The developer has to leave
the conversation to complete a request the agent already understood.

The subagent should install registry items itself, under approval, and hand off
to the dev TUI only for the steps that genuinely require a terminal.

It should do that by driving the install contract eve already publishes —
`eve add <item> --non-interactive` — through one tool, rather than through a new
programmatic registry API. Anything that would ask the developer a question
goes to the wizard built to ask it.

The constraint that looks like it blocks all of this — the subagent's narrow
sandbox — is not the constraint. Extension tools do not run in the sandbox.

## Where the boundary sits

Three surfaces, with different privileges, are involved in one install. Today
the subagent only reaches the first.

```text
┌─ just-bash sandbox ────────────────┐  agent/ mounted at /source, read-write.
│  bash, read_file, write_file,      │  No process execution at all. No network.
│  selfmod__edit_file                │  Widening the mount cannot change this.
└────────────────────────────────────┘
┌─ dev-server process (host) ────────┐  Extension tool bodies run here. Full
│  selfmod__search_registry          │  Node privileges, real network, and the
│  ← proposed install tool           │  ability to spawn a child process.
└────────────────────────────────────┘
┌─ dev TUI process (terminal) ───────┐  Owns stdin and the Prompter. The only
│  /add <address>                    │  surface with a TTY, and the only one
└────────────────────────────────────┘  that may see secrets.
```

`just-bash` executes no binaries — it rejects
`setNetworkPolicy` outright because it "runs no binaries to govern"
(`shared/sandbox-network-policy.ts`). Mounting the whole repository and opening
the network would still leave no process to run `pnpm`, `eve`, or a declared
setup command, while making `package.json` hand-editable by the model and
`.env.local` readable into the transcript. The `/source` mount stays as narrow
as it is today.

The host tool layer already has what installation needs.
`selfmod__search_registry` performs a real `fetch()` against `eve.dev/r` from
that layer, and nothing prevents a tool there from spawning a child process.

### Why a wrapped CLI rather than a raw binary or a new API

Handing the subagent a general `eve` is the wrong shape: `eve add` alone accepts
namespaces, URLs, `--overwrite`, and setup-bearing flags, so an allowlist entry
either admits far more than registry installation or degenerates into argument
parsing in the wrong layer.

A tool that hard-codes the subcommand, forces `--non-interactive`, validates the
address, and builds argv itself is not exposing the binary. It avoids introducing a
second implementation of address resolution, eve-version checking, dependency
installation, and `envVars` reporting.

The eve binary is located the way eve already locates setup binaries:
`findPackageJSON("eve", <appRoot>/package.json)` plus the package's declared bin
(`cli/commands/registry-setup-command.ts`), never a `PATH` lookup.

## What an install actually involves

Of 86 official items: 36 are plain file installs (32 of those also add npm
dependencies), 49 declare an interactive setup command, and 1 is a component
bundle. 33 of the plain items additionally declare `envVars` the developer must
supply — installation completes without them, but the integration does not work
until they are set.

`channel/slack` is an illustrative example, because it exercises everything. Its
`prepare` asks first whether to use Vercel Connect or portable credentials
(`setup/integrations/slack/setup.ts`), and the two answers fail differently:

- **Portable credentials** completes headlessly and exits 0, then reports that
  the developer must set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`, point a
  hand-made Slack app at `/eve/v1/slack`, and deploy for a public URL.
- **Vercel Connect** reaches `apply`, which runs
  `vercel connect create slack --triggers …` (`setup/slack-connect-create.ts`).
  That opens a browser and polls up to five minutes for the workspace to appear.

### Standard Connect connections provision lazily

The Connect-backed connection items are a separate case from channels such as
Slack. With `@vercel/connect` 1.0, an authored connection such as
`auth: connect("linear")` provisions or links its managed OAuth connector on the
first token or authorization request. The request carries the authored
connection URL and connector identifier and is authenticated by the deployment's
Vercel OIDC token. Deployment alone does not trigger provisioning; the first
connection use does.

For each connection that meets that contract, explicit registry setup is not
required. Its registry item should install `@vercel/connect@>=1.0.0`, write the
static connection file, and omit `meta.eve.setup`. The existing catalog rule then
classifies it as installable without any self-modification exception: the tool
installs it, and Connect activates it on first use. Because Connect creates or
links the exact authored identifier, this path has no returned replacement UID
and no source reconciliation step.

## Required human interaction

Two things no automated driver can do, in any of these designs: **click through
a browser authorization**, and **supply a secret**. They are identical whether
the driver is Claude Code at a shell, the subagent in chat, or a script in CI.

This is what fixes the architecture. Today, when hitting one of these actions,
they are asked to leave the conversation and retype a command. They should be
asked in place.

## Authoring API

### The rule: the tool installs, the wizard asks

**An item that declares no setup and no components is installed by the tool. An
item that declares either is handed to the TUI whole, before anything is
installed.**

The split is decidable from the catalog index, which already carries
`meta.eve.setup` and `meta.eve.components` and which `selfmod__search_registry`
has fetched and cached. No extra process, no prediction, no judgment.

The alternative — proxying setup questions into chat so the model can answer or
relay them — was considered and rejected. Both directions fail:

- **Model answers them.** `withPolicy("assume")` takes `detected`, then
  `recommended` (`setup/ask.ts`). Slack's credentials question has no `detected`
  and recommends Vercel Connect, so a developer who wanted portable credentials
  gets an `eve link` prerequisite for a path they never chose. Bundles behave
  the same way: `linear` silently installs both components. Wrong, and invisible
  — the tool reports success.
- **Developer answers them in chat.** Safe, but each question costs a model turn
  and a process spawn, and the wire format loses fidelity on the way:
  `SetupWireOption` carries `hint`, `disabled` + `disabledReason`, and `locked` +
  `lockedReason`, and the question carries `recommended`, while
  `inputOptionSchema` carries `{ id, label, description?, style? }`. The
  developer is shown options they cannot pick with the explanation of why
  stripped out.

### `selfmod__registry_add`

One tool, one fixed argv shape, one terminal event to parse.

```ts
{
  address: string;
} // relative official address
```

It spawns the local eve bin as `eve add <address> --non-interactive
--skip-setup`. With no setup and no questions the run cannot block: it exits 0
or 1. There is no continuation loop, no `--answer`, and no argv composed by the
model.

`--skip-setup` is redundant given the split rule and is passed anyway. The rule
reads a cached catalog index; the manifest is fetched fresh at install. If those
ever disagree, the flag is what keeps a setup flow from starting in a process
with no way to answer it.

The result reports outstanding work rather than a success boolean, because an
installed item can still be non-functional through unset `envVars` — 33 of the
current 36 plain items declare them. Managed OAuth connections add installable
items without adding environment variables, because authorization happens
through Connect on first use. Naming a required variable is not a secret, so
that report belongs in chat.

Approval is `once()` — approved once per session, then quiet. The request
renders the tool input, which is the address. That is the same disclosure the
equivalent shell command gives a human, and it needs no new core mechanism.

### The development capability

The tool needs two things from its host, and neither should come from the
environment.

- `appRoot` is ambiguous in development. The runtime's own `appRoot` can point at
  an **immutable runtime snapshot**. We should publish the dedicated app root.
- The ability to suspend / resume the source watcher will prevent agent-driven
  installs from avoiding collisions / crashes. The primitive already exists and
  already lives here: `AuthoredSourceWatcherHandle` exposes `suspend()`,
  `resume()`, `flush()`, and `rebuild()`
  (`internal/nitro/host/dev-authored-source-watcher.ts`), and its suspension is
  **reference counted**, so a tool-driven install and a concurrent `/add` cannot
  un-suspend each other.

Both of these **development-only capabilities** are resolved from
the tool context. Both are meaningless in a deployed runtime - its absence is
also a signal for a tool that must refuse to run outside `eve dev`.

## Invariant: secrets never round-trip through the model

`SetupWireQuestion` marks `kind: "environment"` as `sensitive: true`, and
`headlessSetupContinuation` deliberately emits no `--answer` for it
(`cli/commands/setup-headless.ts`). The published guidance is explicit: never
pass a secret in `--answer`.

A chat transcript is persisted and model-visible, so the same rule binds here.
Under this design the question never reaches the model at all: a setup-bearing
item is handed to the TUI before it is installed, and the TUI collects the
secret directly.

## Preserving discovery behavior

`selfmod__search_registry` stays as it is. It already reports whether an item is
installed (read through the `/source` mount), the eve version it requires, and
paged results, and it matches bundles against a requested category by inspecting
their components. Nothing here should regress those four.

## What this deliberately does not add

An earlier draft of this plan proposed a public `eve/registry` export, a
resolve/install split, and a core mechanism for tools to contribute disclosure
to their own approval requests. Driving the published CLI contract removes the
need for all three:

- **No new public registry API.** No `resolveRegistryAddress`, no
  `installResolvedItem`, no second implementation of address resolution,
  component selection, or version checking.
- **No core approval-disclosure hook.** Approval requests are built by the
  harness with a fixed prompt and the raw tool input
  (`harness/input-extraction.ts`). Rendering `{ address, answers }` is adequate
  disclosure for a command-shaped tool; a general hook would touch `harness/`,
  the input-request schema, and every channel renderer, which is out of
  proportion to one tool. Revisit only when a second tool needs it.
- **No setup question loop in the agent at all.** No `--answer` accumulation, no
  blocked-event handling, no classification of which questions the model may
  answer. The wizard asks; the tool never does.

## Adjacent fix

`headlessSetupContinuation` should echo the accumulated answers, not only the
newest one. Today every headless driver — Claude Code, CI, a shell script — has
to know to merge, while the documentation tells them to run `next.command` as
printed, which drops earlier answers and loops.

This plan no longer depends on it: the tool never drives a continuation. It is
still a real defect for the drivers that do, and worth fixing on its own.

## Completion criteria

- The subagent installs a no-setup official item end to end without the
  developer typing a command, and reports unset `envVars` rather than reporting
  bare success.
- An eligible managed OAuth connection installs without a terminal handoff and
  relies on Connect's first-use provisioning; ineligible connections retain
  explicit setup metadata.
- A setup-bearing or component-bearing item is never partially installed by the
  tool: it reaches the TUI whole, or in headless dev it reaches the developer as
  a command.
- No setup question is ever answered by the model, and none reaches the
  transcript.
- Installation suspends the authored-source watcher for its whole duration,
  rebuilds on completion, targets the authored application root rather than a
  runtime snapshot, and cannot race a concurrent `selfmod__edit_file`.
- `/add` and `runRegistryFlow` are unchanged.
- Registry resolution, component selection, and setup have exactly one
  implementation.

## Implementation notes

The tool lives beside the existing one in
`packages/eve-self-modification/extension/tools/`, and its instructions and the
package README change with it — both currently tell the model to stop at
discovery and forbid it from acting.

Everything else is in `packages/eve`: exposing the development capability from
the host that already holds the watcher handle
(`internal/nitro/host/start-development-server.ts`) through to the tool context.
No changes to `cli/commands/registry.ts`, `setup/flows/registry.ts`, or the
`/add` command surface.

Both packages are published, so the change needs a changeset covering `eve` and
`@eve/self-modification`.

For tests, the tightest tier that holds each assertion: unit for the split rule
over catalog metadata; integration for the tool's result shape and its refusal
to run without the development capability; scenario for anything that actually
spawns the eve bin. E2E is CI-only — see `e2e/README.md`.
