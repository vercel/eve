---
issue: TBD
status: proposed
last_updated: "2026-08-28"
---

# Self-modification pull requests

## Summary

Self-modification has two execution modes:

- **Local editing:** while `eve dev` runs, a subagent edits the authored source
  tree directly.
- **Draft pull requests:** in a deployed application, a subagent edits an
  isolated checkout, may install official eve registry items, and may create a
  draft pull request for review.

A successful production change means "changed in the proposal." It never
changes the running application, pushes to the target branch, merges, deploys,
configures secrets, or completes deferred activation work. Those remain
separate review and operations boundaries.

```text
accepted deployed session
          │
          ▼
self-modification child session ◄── trusted repository configuration
          │
          ▼
isolated target-branch checkout
    ├── edit application/agent/
    ├── search the official registry
    ├── run fixed eve add operations
    └── collect supported setup answers without a model turn
          │
          ▼
validated proposal ── trusted publisher ── draft pull request
                                              │
                                              ▼
                                  review, merge, and redeploy
```

## Authoring API

The scaffold keeps the agent, sandbox, and extension as separate product
boundaries, but they share one typed configuration module. The agent owns
delegation, the sandbox owns source access and checkout, and the extension owns
instructions, registry coordination, and publication.

```ts
import { defineSelfModificationConfig } from "@eve/self-modification/config";

export default defineSelfModificationConfig({
  development: {
    enabled: false,
  },
  source: {
    git: {
      repository: "github.com/acme/agents",
      directory: "apps/support-agent",
    },
  },
  target: {
    branch: "main",
  },
});
```

`development.enabled` controls direct source edits under `eve dev` and defaults
to `true`. `source.git.repository` is the only GitHub repository the production
flow may access. `source.git.directory` is the repository-relative application
root containing `agent/`; `"."` represents the repository root.
`target.branch` is both the checkout base and the draft pull request base.
Omitting either `source` or `target` disables production self-modification.

The same config is passed to the agent and sandbox definitions and mounted as
the extension config. The model belongs to the agent definition; a custom
process-capable sandbox backend belongs to the sandbox definition. GitHub
credentials are operational configuration and never authored configuration.

## One authoring surface, two execution modes

Local editing and draft pull requests use the same dynamic self-modification
subagent and typed configuration, but have different effect boundaries:

| Shared boundary       | Local development                                                                 | Deployed pull request                                                                                      |
| --------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Purpose               | Makes persistent authored-source changes; changes do not affect the current turn. | Prepares persistent authored-source and official registry changes; changes do not affect the current turn. |
| Source workspace      | Directly edits the authored `agent/` directory mounted at `/source`.              | Edits an isolated checkout of the configured target branch.                                                |
| Registry installation | Keeps the existing development flow.                                              | Runs a constrained, trusted `eve add` operation in the configured application root.                        |
| Result                | The change is available on a subsequent local turn.                               | The change becomes effective only after review, merge, and redeployment.                                   |
| Activation            | Selected when `EVE_DEV=1`; `development.enabled` defaults to `true`.              | Selected outside development when `source` and `target` are configured and trusted prerequisites pass.     |
| GitHub capability     | Has no GitHub credential or publication capability.                               | Trusted checkout and publication code resolve separate credentials outside the model sandbox.              |

The modes are mutually exclusive. Even when production is configured,
`eve dev` selects local editing unless `development.enabled` is `false`; it
never uses the deployed pull request workflow.

## Production source and workspace

A production child fetches the configured target branch tip and owns one
isolated checkout for its lifetime:

```text
/workspace/                         repository checkout, readable for discovery
/workspace/apps/support-agent/      configured application root
/source/                            writable view of application/agent/
/eve-docs/                          read-only version-matched eve docs
```

The configured repository, application directory, and target branch are the
source authority. This MVP does not capture or reproduce the revision currently
deployed. If the target branch moves after checkout, publication fails and asks
the user to retry rather than silently rebasing.

The full checkout is readable because registry installation may need a root
manifest, workspace configuration, and lockfile. Ordinary model mutation tools
remain rooted at `/source`. Production must replace or wrap generic file and
shell tools if they cannot enforce that boundary.

The trusted registry coordinator is the only broader writer. It may run a fixed
`eve add` operation in the application root and retain only the package,
lockfile, and generated source changes attributable to that operation. It
accepts no model-supplied command, executable, flags, URL, or environment.

One child-session lock serializes model edits, registry installs, rollback, and
final capture. A failed or cancelled install restores its starting tree without
discarding earlier model edits or completed installs.

## Proposal integrity

A proposal is captured from the prepared workspace, not supplied by the model.
It records the immutable target-branch base, proposed tree, total changed bytes,
and each changed path and Git object. Publication enforces two mutation rules:

1. paths below the configured application's `agent/` directory may contain the
   final model-authored contents;
2. every other changed path must exactly match the recorded after-state of a
   completed registry operation.

Each successful registry operation records its starting and resulting trees,
changed paths, object IDs, modes, installed items, required environment variable
names, and whether activation remains. A later operation may supersede the
record for a shared manifest or lockfile. Publication rejects an outside-
`agent/` file changed after the final applicable registry operation.

Proposal capture also rejects malformed paths, path escapes, symlinks, unsafe
file modes, `.git`, `.env*`, self-modification policy or config, dependencies,
build output, and changes over the file or byte limits. Repository-specific
typechecking, tests, dependency installation, and preview builds remain pull
request CI responsibilities.

Mutation state belongs to `@eve/self-modification`; it is not a generic
framework session-mutation journal. An active mutation identifies its rollback
boundary and associated setup operation. A completed private receipt authorizes
exact Git objects outside `agent/`, but contains no setup answers, secrets, or
provider continuation state.

## Registry tool API

Production adds `selfmod__registry_add` beside registry search. Its only
model-authored input is an exact official registry address such as
`channel/slack`. Trusted code runs the checkout's own CLI with fixed arguments:

```text
eve add <address>
  --non-interactive
  --silent
  [--skip-install]
  [--answer <key>=<JSON> ...]
```

The MVP excludes third-party registries, URLs, `@skills` addresses, arbitrary
shell arguments, and environment overrides.

The checkout may not have dependencies. The first install lazily finds the
package-manager root, performs a frozen install with lifecycle scripts disabled,
and resolves the checkout's locked eve binary. It never uses `PATH`, `npx`, or
the running deployment's eve binary. Installed dependencies remain untracked.
Initial support may be limited to package managers for which these guarantees
can be enforced.

The process receives no application secrets, user-supplied provider secrets, or
GitHub token. Source installation network access is limited to the official eve
registry and the package registry required by the locked install. Built-in
setup adapters may separately receive a narrowly scoped workload credential and
fixed provider-host allowlist; a setup answer cannot broaden egress.

The model receives only a concise terminal result:

```ts
type ProductionRegistryAddResult =
  | {
      status: "installed-in-proposal";
      address: string;
      changedPaths: readonly string[];
      envVars: readonly string[];
      setup: "complete" | "activation-required";
    }
  | { status: "unsupported"; address: string; reason: string };
```

Answers, secrets, pending request IDs, provider continuation state, and
publication records never appear in model-facing output.

## Model-bypassing setup coordination

A deployed agent has no setup TUI. Supported registry questions and durable
browser or device authorization therefore use a framework-owned, channel-neutral
`tool-input` request. They never ask either the parent or child model to relay
setup.

When headless setup returns `input_required`, trusted coordination code parks
the registry tool call and sends a plain-text prompt through the session's
normal reply route. The operation ID, accumulated answers, and immutable request
ID are private durable runtime state—not `session.state`, model messages, or
model-facing output. A valid reply is journaled, the same tool execution
resumes, and the CLI reruns with all accumulated answers.

The harness addition remains narrow: it parks, routes, authorizes, cancels, and
replays trusted tool input, including child-to-parent pending-input proxying. It
does not gain a public `ToolContext.requestInput()`, generic durable operation
store, or workflow API. A request cannot park beside a sibling effectful tool
call that cannot be replayed safely.

Only the initiating session's attributed and authorized responder may answer;
there is no anonymous fallback. Stale, malformed, cross-session, and
unauthorized replies do not resume setup. Channels need only a stable session or
reply route, attributed inbound text, and ordinary outbound text. Outbound-only
or uncorrelated transports report setup as unsupported before parking.

Questions are rendered as numbered plain text. Multi-select uses comma-separated
numbers, and editable select uses an explicit `custom: <value>` form. Invalid
input creates a replacement prompt and does not reach a model. Prompts explain
that the next correlated reply is setup input and always provide an explicit
cancel response.

### Durable external authorization

A live subprocess cannot be the continuation for browser or device setup: a
parked action may resume on another worker. Supported setup adapters therefore
turn an external action into private durable data with idempotent `inspect`,
`complete`, and `cancel` operations. Only safe presentation data—message, URL,
user code, and expiration—is sent to the user.

On `continue`, trusted code inspects the stored provider operation. Completion
finalizes it idempotently; a pending action creates a new immutable input
attempt; expiration, failure, or cancellation performs cleanup and returns an
actionable result. Worker replacement restores the private continuation rather
than a subprocess. Slack, managed Linq, and Photon are the initial adapters.
Automatic callback-driven resume is not required; an explicit `continue` reply
is the MVP wake-up mechanism.

Private setup state belongs to `eve/setup`, whose built-in integrations already
own provider setup. `@eve/self-modification` stores only a setup operation ID and
terminal result; it never interprets answers or provider continuation data. The
harness treats setup state and mutation receipts as opaque.

### Unsupported interactions

Tool input never collects passwords, API keys, environment variable values, or
other secrets. It also rejects file uploads, device-local choices, and external
effects that cannot be inspected, completed, and cancelled idempotently.

If deterministic source installation completes before an unsupported
prerequisite, the proposal keeps it and reports
`setup: "activation-required"`, including required environment variable names
and actionable post-deployment guidance. If useful installation cannot be
separated safely from the prerequisite, the operation rolls back and returns
`unsupported`. Non-blocking activation URLs remain proposal follow-up work.

## Publish tool API

The publish tool is available only in a delegated production session after
configuration, workspace, and credential checks pass. Its model-facing input is
limited to pull request presentation:

```ts
{
  title: string; // 1–256 characters
  summary: string; // 1–10,000 characters
}
```

The tool derives the repository, target branch, base revision, workspace,
registry receipts, and replay-safe operation identifier from trusted context.
It does not accept a branch, repository, base revision, changed path, Git object,
credential, or operation ID from the model.

Publication captures and validates the complete proposal before resolving a
write credential. It may create Git objects, a branch under
`eve-self-modification/`, and a draft pull request against the configured target
branch. It cannot update that branch, merge, approve, close, or retarget a pull
request. Retrying finds or updates the same draft; target-branch movement causes
publication to fail.

The result and final review identify the repository and target branch, generated
branch, commit, every changed path, installed registry addresses, package and
lockfile changes, required environment variable names, deferred activation, and
draft pull request URL. They state that merge and deployment have not occurred.

## GitHub credentials

GitHub credentials remain in trusted checkout and publication code. They never
enter prompts, model sandboxes, durable setup state, Git remotes, or registry CLI
environments. One internal provider boundary resolves separate just-in-time
checkout and publication tokens.

### Vercel production

A production deployment on Vercel uses the ordinary Vercel GitHub App linked to
its project:

1. eve obtains workload identity for the running Vercel project;
2. a workload-authenticated broker verifies that the exact project Git link
   matches `source.git.repository`;
3. the broker resolves the ordinary Vercel GitHub App installation; and
4. it mints a repository- and permission-scoped installation token.

Checkout receives Contents read. Publication receives Contents write and Pull
requests write. Scoped requests bypass any installation-wide token cache. The
broker rejects previews initially, owner fallback, unrelated repositories,
OAuth-user credentials, missing or suspended installations, and
caller-selected permissions. Audit records identify the project, deployment,
repository, installation, and capability, never the token.

This is trusted workload authentication, not deployment-source tracking. A
broker failure never falls back to a PAT.

### PAT alternative

CI, self-hosted, and other supported GitHub deployments use
`EVE_SELF_MODIFICATION_GITHUB_TOKEN`. The recommended fine-grained PAT is
restricted to the configured repository with Contents and Pull requests
read/write. It uses the same trusted provider boundary.

## Setup and scaffolding

`eve add experimental/self-modification` generates `config.ts`. Non-interactive
installation leaves the default local-editing configuration intact.

Interactive setup detects and displays the GitHub repository,
repository-relative application directory, and default branch before writing
`source` and `target`. It does not silently overwrite or broaden existing
authored configuration. The generated agent, sandbox, and extension entrypoints
consume the same value.

For a Git-connected Vercel production project, setup explains that the linked
Vercel GitHub App supplies credentials and does not request a PAT. Manual and
self-hosted deployment setup instructs the operator to configure the PAT as a
secret. Setup never writes credentials into source.

## Ownership and validation

Changes under `packages/eve` are limited to two framework-owned surfaces:

- the harness owns the narrow `tool-input` pending-input kind, trusted
  interruption, response routing, child proxying, replay, authorization, and
  cancellation;
- `eve/setup` owns setup answer accumulation, private continuation storage,
  external-action outcomes, and the Slack, Linq, and Photon adapters.

`packages/eve-self-modification` owns production configuration and mode
selection, checkout and constrained workspaces, registry invocation, mutation
serialization and rollback, proposal validation, and draft publication. The
packages share only stable operation IDs and terminal setup results.

Focused tests must cover configuration and path validation, nested workspaces
and lockfiles, exact registry after-state enforcement, rollback boundaries,
model-bypassing answer replay, worker replacement during external setup,
idempotent completion and cancellation, responder authorization, absence of
private state from model and terminal output, credential downscoping, target
branch movement, and replay-safe publication.

A fixture-owned E2E eval is the official proof that a deployed parent delegates
once, setup replies bypass both models, the child continues editing, and one
draft pull request contains ordinary edits plus registry source, manifest, and
lockfile changes.

## Scope and limitations

The initial flow supports one GitHub repository and target branch per
definition, official registry items, and package managers whose locked bootstrap
can be enforced. It does not support GitLab, Bitbucket, forks, coordinated
multi-repository proposals, third-party registries, private package registry
credentials, Git LFS, arbitrary networked validation, deployment actions, or
merging a proposal.

There is no self-modification-specific principal policy or in-session approval
prompt. Every session accepted by an application with production
self-modification configured can request a draft pull request. Applications must
protect inbound routes and channels before enabling it.

## Future work

- Compare proposals with the deployed revision and verify deployment after
  merge.
- Replace plain-text setup presentation with optional native channel widgets
  over the same answer contract.
- Add callback-driven wake-up for supported external authorization.
- Broker secrets and additional reconcilable external setup effects.
- Support more package managers and third-party registries with equivalent
  integrity guarantees.
- Add explicit policies over verified session principals, checked before
  sandbox preparation and again before publication.
- Add optional bounded formatting, typechecking, or focused tests without
  publication credentials; full validation remains pull request CI.

## Future exploration, not planned

The flow is conversation-driven: the root agent delegates when a user asks for
a persistent source change or registry installation. It may infer that a request
should persist, but it does not initiate self-modification without a
conversational request.

Schedules, evaluations, CI failures, telemetry, and source conditions are a
separate future area. Each would need explicit trigger policy, bounded input
provenance, deduplication, rate limits, and authorization. An untrusted event or
model observation must never become authority to modify source or publish a pull
request.
