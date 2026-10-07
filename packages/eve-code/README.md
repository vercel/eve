# eve/extensions/code

`eve/extensions/code` is an eve extension for coding work. It contributes `apply_patch`, `grep`, investigation and review skills, a read-only worker subagent, sandbox tooling, and shared PR-watch primitives. Vercel credentials are brokered before each turn. GitHub instructions, the `pr` skill, and the authenticated `gh` tool live in [`eve/extensions/git`](../eve-git/README.md). Because eve workflow directives are application-only, consumers own their `prwatch` / `prwatch_delete` workflow tools.

It ships inside the `eve` package. This private `@eve/code` workspace package is its source of truth: eve's build copies `extension/` into `packages/eve/src/extensions/code/extension` and publishes it with these entry points:

- `eve/extensions/code`: the extension
- `eve/extensions/code/sandbox`: sandbox bootstrap and credential helpers
- `eve/extensions/code/tools`: `apply_patch` and `grep` (`gh` is a deprecated re-export)
- `eve/extensions/code/prwatch`: PR-watch primitives for consumer-owned workflow tools

## Mount

```ts
// agent/extensions/code.ts
import code from "eve/extensions/code";

export default code({
  // Optional; omit to mount without Connect-backed Vercel authentication.
  vercel: { connector: "vercel/acme-bot" },
});
```

Both connectors are optional; `code({})` mounts without either. The Vercel connector requests an app-subject token. Firewall delivery is the default and keeps tokens outside sandbox processes; without a consumer `broker`, it requires a sandbox provider that exposes `setNetworkPolicy()` and fails otherwise. Use `delivery: "command"` on the Vercel connector for providers without mutable network policy. A top-level `broker(sandbox, rules)` callback lets the consumer merge Vercel credential rules into its own network policy.

The `github` option is deprecated; configure it on `eve/extensions/git` instead. While it is set here, this extension still contributes `code__gh`, its GitHub instructions, and the signed-commit `code__pr` skill. Without it, this extension contributes no GitHub tool, instructions, or pull request skill.

The read-only worker subagent defaults to `openai/gpt-5.6-terra-fast` with `xhigh` reasoning. Set `worker: { model, reasoning, openaiReasoningEffort? }` to choose another model; `openaiReasoningEffort` is passed to OpenAI models as `reasoningEffort`.

## Sandbox bootstrap

Install CLI tooling in the environment's `prepare` callback:

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import { installCodeTooling } from "eve/extensions/code/sandbox";

export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await installCodeTooling(sandbox, { vercel: true });
  },
});

export default defineSandbox(() => environment.open());
```

eve derives the prepared environment generation from the sandbox file and environment options, not from imported helpers, so upgrading eve alone does not rebuild an existing prepared artifact.

Computer use lives in `eve/computer-use`. Mount it next to this extension when the sandbox has a desktop. `installComputerUse`, `startComputerUse`, and `COMPUTER_USE_REVALIDATION_KEY` are still re-exported from `eve/extensions/code/sandbox`, and `computer_use` from `eve/extensions/code/tools`, but both are deprecated.

Preparation ensures `gh`, installs wrappers for `gh`, `vc`, and `gh-signed-commit`, and installs TypeScript diagnostics. With `eve/extensions/git` configured for `github`, repositories requiring verified signatures use `gh-signed-commit` through its `gh` tool.

## Non-Connect escape hatch

Consumers with a PAT, benchmark token, or another credential provider can omit the corresponding connector and call `authenticateGitHub` or `authenticateVercel` from `eve/extensions/code/sandbox` in their own sandbox lifecycle. These helpers support firewall, command-delivery, and broker options for consumer-owned commands; they do not configure the extension's `gh` tool.

## Develop in this workspace

Rebuild eve after editing `extension/`; the local agent under `agent/` mounts the built `eve/extensions/code`:

```sh
pnpm --filter eve build
pnpm --filter @eve/code typecheck
pnpm --filter @eve/code test
pnpm --filter @eve/code test:scenario
pnpm exec oxlint packages/eve-code
pnpm exec oxfmt --check packages/eve-code
```

Tests live under `test/`, outside the extension distribution. Unit and integration tests run through the workspace's matching test tasks. The package integration task depends only on eve's build. The root integration command runs the framework suite before the other packages because that suite rebuilds the runtime files they import. Scenario tests exercise temporary files, local Git repositories, and subprocesses; they need Node.js 24 or newer, Git, and Bash, but no model or service credentials.

The `typescript-compiler` development alias supplies the JavaScript compiler API used by the diagnostics worker test. The workspace's TypeScript 7 CLI remains the package typechecker. `prepack` builds the extension; installation does not run the extension CLI before the local framework has been built.

## Benchmarks

eve-code is benchmarked with [eve-bench](https://github.com/vercel-labs/eve-bench#readme) on the SWE-lean dataset. eve-bench owns datasets, execution, comparisons, and reports; this package keeps no benchmark runner of its own.

### In CI

The `eve-code > Benchmark harness` workflow runs whenever `packages/eve-code/**` changes. It benchmarks the PR head's eve-code, opencode, and pi together, using the model in the `EVE_CODE_BENCH_MODEL` repository variable. Every trial runs in its own Vercel Sandbox, and all of them start at once, so a run takes about as long as its slowest trial. Each harness is compared with its own latest result from `main`. The report covers resolved tasks, latency, and token usage. It goes to the job summary and a PR comment.

Comment `/benchmark` to re-run the default harnesses, or `/benchmark <harness>[,<harness>...]` to choose, for example `/benchmark codex,eve-code`. You need write access to the repository. Every push to `main` that touches eve-code publishes fresh results to the eve-bench result store, which is where later PRs get their baselines.

### Locally

With [eve-bench](https://github.com/vercel-labs/eve-bench#readme) linked (`npm link` in its checkout), commit and push this checkout, then run:

```sh
eve-bench -a eve-code --agent-dir packages/eve-code --model openai/gpt-6-luna --reasoning low \
  --scope <vercel-team> --execution vercel-sandbox
```

Pass several harnesses to compare them in one run, for example `-a eve-code,opencode,pi`. Use `--task <name>` to run a single task. Local runs never publish to the result store.

### Investigating a failed trial

Trial sandboxes are deleted as soon as each trial finishes. Before deletion, eve-bench pulls each trial's logs and traces out of the sandbox and uploads them with the workflow artifact. To read them, point eve-bench at the CI run:

```sh
eve-bench trials logs https://github.com/vercel/eve/actions/runs/<id>
eve-bench trials logs https://github.com/vercel/eve/actions/runs/<id> --harness eve-code --task <task>
```

The report's Diagnostics section prints this command with the run URL filled in. The download uses the GitHub CLI and needs read access to this repository. The raw files (`agent.log`, `events.ndjson`, `observability.ndjson`, `verifier.log`) are cached under `~/.cache/eve-bench/runs/`.

## eve-gh preview

`eveGh.enabled` exposes the extension's `eve_gh` subagent, named
`code__eve_gh` when mounted as `code`. It defaults to false. The child runs
coding tasks with eve's built-in shell and file tools in its own GitHub checkout;
it does not share the parent's workspace. eve owns sandbox persistence, resume,
and deletion. The agent server continues to run in the host application.

```ts
import { connect } from "@vercel/connect/eve";
import code from "eve/extensions/code";

export default code({
  eveGh: {
    enabled: process.env.EVE_GH_ENABLED === "1",
    auth: connect({
      connector: "<Vercel user OAuth connector UID>",
      principalType: "user",
      validate: true,
      // Sandbox access is an app permission granted during team consent, not an
      // OIDC scope. offline_access lets Connect refresh the user's access token.
      tokenParams: { scopes: ["openid", "profile", "email", "offline_access"] },
      displayName: "Vercel Sandbox",
      instructions: "Connect your Vercel account to start your coding sandbox.",
    }),
    resolveOptions: () => ({
      repository: "https://github.com/vercel/internal-agents",
      revision: process.env.VERCEL_GIT_COMMIT_SHA,
      teamId,
      projectId,
    }),
  },
});
```

eve compiles this extension into `eve/extensions/code` and cannot import
`@vercel/connect/eve` (that adapter imports eve), so the consumer supplies the
user-scoped authorization as `eveGh.auth`.

The child's first shell or file operation uses eve's interactive authorization
flow to connect the current user's Vercel account. Configure a Vercel Connect
OAuth connector whose Vercel app allows the OIDC scopes `openid`, `profile`,
`email`, and `offline_access`, and the API permission `read-write:sandbox`.
The permission is configured on the Vercel app using the v2 permissions model;
it is not an OIDC scope. Users must grant access to the target team/project during
consent. Link the connector to the consuming project. A read-only Vercel MCP
connector is not sufficient evidence of Sandbox permission. The user's Vercel
token authorizes sandbox creation and resume; the verified Vercel userinfo supplies
the commit coauthor. Only the caller and Vercel account IDs are stored in authored
session state. A different caller or a changed Vercel account must start a new
coding session.

The child then uses Devbox's existing [setup](https://github.com/vercel/api/blob/7f5d4fdbe6b71c377cb4163fa7e8a04712cf9d24/services/api-devbox/src/endpoints/setup-devbox.ts)
and [registration](https://github.com/vercel/api/blob/7f5d4fdbe6b71c377cb4163fa7e8a04712cf9d24/services/api-devbox/src/endpoints/register-devbox.ts)
exchange, authenticated by that user, to obtain the owner's Vercel token and
their GitHub OAuth Login Connection token. These become `VERCEL_TOKEN` /
`VERCEL_API_KEY` and `GH_TOKEN` / `GITHUB_TOKEN` on shell commands. The adapter
does not forward the installation token, project environment, or other returned
secrets. Missing human GitHub credentials fail with a request to connect GitHub
in Vercel's Login Connections; there is no bot-token fallback for these variables.
These credentials are visible to code executing inside the sandbox, as in
Devbox, but are not placed in authored state, deployment settings, or files by
the adapter.

This reuses the internal Devbox service, so the user must belong to its allowed
internal teams. Setup registers the existing sandbox with `skipDevboxdInstall`
and adds Devbox's agent port; it does not install a daemon. eve continues to own
commands and compute lifecycle. Resume re-registers the same Devbox ID and
refreshes runtime credentials. Only that ID is added to the provider's session
state. Session deletion revokes the Devbox record before deleting the sandbox;
stopping preserves both for resume. No Devbox heartbeat or task is created.
The service currently issues other startup credentials during registration;
the adapter discards those fields.

The child uses a dedicated sandbox provider, `eve-gh`, that wraps
eve's Vercel provider. Credentials are resolved only when a session starts or
resumes, never during preparation. Keep this child free of skills and workspace
seeds: those require a template snapshot, which cannot issue the new sandbox's
managed Git grant, so preparation rejects them rather than silently creating an
unauthenticated checkout. Each fresh sandbox is created from a Git source; resume
reconnects to the existing named sandbox and fails if it no longer exists.

The project must be enabled for `vercel-sandbox-git-credentials` and
`vercel-sandbox-signed-commits`, have a Git Bound (a project/repository permission)
authorizing the required Git actions, and use a repository accessible to the
Vercel GitHub App. Creation currently requires a user-scoped Vercel token; project
OIDC is insufficient. The provider does not create Bounds or change platform
flags. API errors propagate to the caller without falling back to unmanaged
credentials.

Sandbox owns Git credentials and commit signing; Devbox supplies the user's
GitHub API credential separately. eve's pinned Sandbox SDK does not yet expose
these preview fields, so the provider adds `source.credentials: true` and
top-level `commitAs` to its creation request through the SDK's fetch option.

The current [signing preview contract](https://github.com/vercel/api/blob/f42b9d530ffd60245fb00eae0a741de5da2156be/hive-containers/sandbox-controller/README.md#supported-push-contract)
requires an existing remote branch and linear commits; it rejects new-branch,
merge, and force pushes. Create a new remote branch through the user's GitHub
API access before pushing to it. Signing changes commit IDs, so the child reports
the post-push HEAD.

The opt-in live check is `pnpm --filter @eve/code verify:eve-gh`. It uses the
same provider, but bypasses interactive consent for a manual platform diagnostic.
Supply a short-lived user token as `EVE_GH_CHECK_TOKEN` and coauthor identity
as `EVE_GH_CHECK_NAME` / `EVE_GH_CHECK_EMAIL` only in that local process,
plus `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, and `EVE_GH_REPOSITORY`.
The check requires a full commit SHA in `EVE_GH_REVISION`, and
explicitly creates a temporary sandbox regardless of the feature flag. It verifies
the clean checkout and remote Git read access, stops and resumes the sandbox,
repeats the read checks, then deletes it. It also exchanges Devbox credentials and
checks authenticated Vercel and GitHub API access from a command. It does not push
or establish that signed commits work. Unit tests use mocked HTTP responses; they
verify SDK requests and provider lifecycle integration, not live Git authorization
or signing.
