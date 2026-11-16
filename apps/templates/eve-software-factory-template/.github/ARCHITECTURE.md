# Architecture

The eve software factory runs on Vercel. Its root agent routes GitHub and Linear work through independent stations and delivers draft pull requests on `FACTORY_REPO`. A person marks work ready and merges it. Merge tools are not mounted.

## Components

- `agent/agent.ts` and `instructions.ts` define the orchestrator and pipeline.
- `agent/channels/github.ts` accepts verified writer mentions, triage-authorized label intake, and failed checks on factory branches in the configured repository. Automatic PR-open summaries are disabled.
- `agent/channels/linear.ts` accepts identified member sessions only from `LINEAR_WORKSPACE_ID`.
- `agent/channels/eve.ts` authenticates the local TUI and Vercel OIDC route.
- `agent/extensions/github.ts` mounts an explicit GitHub tool allowlist. Repository guardrails restrict calls to `FACTORY_REPO`; context defaults alone are not authorization.
- `agent/connections/linear.ts` exposes app-scoped MCP tools only to trusted Linear member sessions from the configured workspace. GitHub sessions cannot use them, including reads.
- `agent/lib/trust.ts` owns repository-bound trust stamps and the constructed autonomous principal.
- `agent/lib/github/approval.ts` owns authorization and human approval policies.
- `agent/lib/github/git-transfer.ts` owns authenticated Git transport in fresh disposable sandboxes.

## Pipeline

The root calls `run_classifier`, optional `run_researcher`, `run_analyst`, `run_implementer`, and `run_reviewer`. Workflow tools call `ctx.agent(id).send(message, { outputSchema })` and await `result()`. Each station declares `tool: false` and receives a self-contained handoff, not the parent's history or capabilities. The implementer and reviewer use different model vendors. Review can request at most two revision cycles.

Classifier is text-only. Researcher saves cited research. Analyst plans against its own checkout. Implementer changes code, runs repository checks, commits, and calls `push_branch`. Reviewer imports the pushed branch and judges the real diff independently. Only the root opens a draft PR or requests human approval.

Long handoffs live in private Blob storage under `artifacts/`; the root passes validated artifact IDs rather than copying entire documents into messages.

## Authorization boundaries

GitHub hooks compare the signed event repository with `FACTORY_REPO`, then resolve its canonical numeric identity through GitHub. Events from another repository never dispatch. Mentions additionally verify that comment author and sender agree and that the sender has write, maintain, or admin permission on that target. `author_association`, prompt text, and message From fields are not permission checks.

Label intake verifies at least triage permission. CI intake verifies that the PR head belongs to the configured repository, not a fork with a matching branch prefix. These sessions use a constructed autonomous principal, not the sender's identity. They can label, comment on the intake thread, close/reopen issues, and open draft PRs. Other reversible writes are denied rather than parked. A state update mixed with other issue edits must pass the normal write policy.

Trusted stamps name the configured repository. GitHub stamps must also match the source repository. The Linear channel stamps trust only after checking the configured organization and an identified actor. The Linear connection independently checks this authorization on every tool call. An ordinary GitHub identity is never evidence of Linear membership.

Automatic PR summaries remain disabled until a separate capability-limited agent exists. A summarization prompt is not a security boundary. On upgrades, restart existing sessions to remove prior authorization and credentialed checkout state.

## Git transport

Stations execute arbitrary repository setup commands, tests, and dependencies. Their filesystem, Git configuration, environment, executables, hooks, and background processes are untrusted. No installation token or credentialed network policy is installed in a station, even briefly. The channel's built-in credentialed checkout is disabled too.

For clone/fetch, a fresh Vercel Sandbox clones one branch into a bare repository without checking it out. It exports an object bundle, then loses its network policy and stops in `finally`. The station imports that bundle without credentials before running setup. No repository code executes in the transfer sandbox.

For push, the station exports a bundle. The app validates the destination ref and verifies the target repository's actual default branch and branch protection through GitHub. A new transfer sandbox receives only bundle bytes. Its system Git runs with a clean environment, system/global config disabled, and hooks disabled. It imports the selected branch into a fresh bare repository and pushes its commit SHA to exactly one factory-prefixed destination ref, without force or tag propagation. Station configuration cannot redirect the push or add refs.

Transfers have a 120-second VM lifetime and a 64 MiB bundle limit. The selected branch's full history is transferred. Oversized or failed transfers stop rather than falling back to station credentials. Keep default-branch protections enabled as defense in depth.

## Storage

Private Vercel Blob holds principal-scoped preferences (`user-preferences/`), repository-scoped shared notes (`factory-brain/`), and bounded handoff documents (`artifacts/`). Shared helpers enforce reserved namespaces. Artifact IDs cannot contain path separators or dots. Artifact saves do not overwrite. Brain writes deny autonomous sessions; repository-bound trusted callers write directly, while other authenticated local callers need approval.

GitHub and Linear remain external systems of record. Station sandboxes are disposable workspaces, not durable application stores.

## Configuration and development

`FACTORY_REPO` and connector UIDs select resources; `LINEAR_WORKSPACE_ID` enables the matching Linear workspace. Missing workspace configuration disables Linear intake and MCP access. `FACTORY_SETUP_COMMAND` runs only after uncredentialed import. Models live in `agent/lib/models.ts`.

Use `pnpm validate` for template formatting, types, and discovery. `pnpm test` runs authorization, private-storage, and real local Git boundary tests without cloud credentials. Evals under `evals/` exercise routing and safety through eve; full-pipeline evals push real branches and require deliberate use of a scratch repository. See `AGENTS.md` and `README.md` for setup and operational limits.
