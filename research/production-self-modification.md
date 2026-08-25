---
issue: TBD
status: proposed
last_updated: "2026-08-24"
---

# Self-modification pull requests

## Summary

Self-modification has two capabilities:

- **Local editing:** while `eve dev` runs, a subagent edits the authored source tree directly.
- **Draft pull requests:** in a deployed application, a subagent edits an isolated checkout and may create a draft pull request for review.

A draft pull request never changes the running application, pushes to the base branch, merges, or deploys a change. Review, merge, and redeployment remain separate boundaries.

```text
accepted deployed session
          │
          ▼
self-modification child session ◄── trusted repository + deployed revision
          │
          ▼
isolated checkout ── edit ── validated proposal
          │
          ▼
trusted publisher ── namespaced branch ── draft pull request
                                              │
                                              ▼
                                  review, merge, and redeploy
```

## Authoring API

The scaffold keeps the agent, sandbox, and extension as separate product boundaries, but they share one typed configuration module. The agent owns delegation, the sandbox owns source access and checkout, and the extension owns instructions and publishing.

```ts
import { defineSelfModificationConfig } from "@eve/self-modification/config";

export default defineSelfModificationConfig({
  development: {
    enabled: false,
  },
  pullRequests: {
    git: {
      repository: "acme/support-agent",
      baseBranch: "main",
    },
  },
});
```

`development.enabled` controls direct source edits under `eve dev` and defaults to `true`. Omitting `pullRequests` disables self-modification outside local development. `pullRequests.git` makes both the Git boundary and the result explicit: `repository` is the only GitHub repository the flow may access, and `baseBranch` is the pull request target.

The same config is passed to the agent and sandbox definitions and mounted as the extension config. The model belongs to the agent definition; a custom process-capable sandbox backend belongs to the sandbox definition. The PAT is operational configuration, never authored configuration.

Any deployed application that includes `pullRequests` enables the draft-pull-request capability.

## One authoring surface, two execution modes

Local editing and draft pull requests use the same dynamic self-modification subagent and typed configuration module, but they have different effect boundaries:

| Shared boundary   | Local development                                                                 | Deployed pull request                                                                                 |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Purpose           | Makes persistent authored-source changes; changes do not affect the current turn. | Makes persistent authored-source changes; changes do not affect the current turn.                     |
| Source workspace  | Directly edits the authored `agent/` directory mounted at `/source`.              | Edits an isolated checkout of the configured pull request base.                                       |
| Result            | The change is available on a subsequent local turn.                               | The change becomes effective only after review, merge, and redeployment.                              |
| Activation        | Selected when `EVE_DEV=1`; `development.enabled` defaults to `true`.              | Selected outside development when `pullRequests` is configured.                                       |
| Sandbox boundary  | Uses the constrained `just-bash` filesystem.                                      | Uses a per-session VM or container, trusted deployment source, and proposal capture.                  |
| GitHub capability | Has no GitHub credential or publication capability.                               | Trusted checkout and publication boundaries resolve the credential separately from the model sandbox. |

The modes are mutually exclusive. Even when `pullRequests` is configured, `eve dev` selects local editing unless `development.enabled` is `false`; it never uses the deployed pull request workflow.

## Vercel deployments

When the deployment runs on Vercel, the self-modification sandbox selects Vercel Sandbox automatically. A self-hosted deployment instead needs the process-capable backend supplied by its sandbox definition.

Vercel Git metadata supplies the deployment source when no explicit `EVE_SOURCE_*` source metadata is set. The metadata identifies the GitHub owner and repository, deployed commit SHA and ref, plus the Vercel deployment ID and creation time. The deployed revision remains the inspection baseline; self-modification still edits the configured pull request base. Explicit source metadata takes precedence over the Vercel metadata.

## Trusted deployment source

A proposal starts from the immutable source identity captured when eve builds the deployment: repository host and path, full revision, and repository-relative application root. Runtime Git state, package metadata, a user request, and model output are not provenance authorities.

### Why use the deployment source instead of checking out the default branch

A checkout of the repository's current default branch alone cannot establish what the running agent represents. That branch can advance after deployment, be renamed, or contain commits that were never deployed. Starting there would let self-modification investigate and propose against arbitrary repository state rather than the source the requester is using.

The captured deployment revision gives the sandbox an immutable investigation baseline, while the configured base branch remains the intentional target for a mergeable pull request. Fetching both and requiring the deployed revision to be an ancestor of the base answers two separate questions: which source produced this deployment, and whether the proposal can safely target the current review branch. The repository-relative application root also prevents a monorepo checkout from treating an unrelated application as the deployed agent. Deployment source is the provenance boundary; the base checkout is only the editing target.

Before checkout, self-modification verifies that deployment source metadata exists, was not derived from a local build, and identifies `github.com/<configured repository>`. The checkout fetches both the deployed revision and the latest configured base branch. The deployed tree supports investigation; edits apply only to the base checkout. The deployed revision must be an ancestor of the base.

## Proposal API

A proposal is captured from the prepared sandbox workspace, not supplied by the model. It records the immutable base revision and tree, the proposed tree, the total changed bytes, and one record for every changed path:

```ts
interface SelfModificationProposal {
  readonly baseSha: string;
  readonly baseTreeSha: string;
  readonly proposedTreeSha: string;
  readonly changedBytes: number;
  readonly changes: readonly {
    readonly path: string;
    readonly kind: "add" | "delete" | "modify";
    readonly mode: "100644" | "100755" | null;
    readonly objectId: string | null;
    readonly bytes: number;
  }[];
}
```

The publisher captures this value after editing, validates its paths, file kinds, size, and Git object IDs, then reconstructs the Git tree from the captured blobs. The model cannot choose the base revision, repository, branch, changed paths, or blob identities. This separates the model-written pull request description from the source change that publication verifies.

## Publish tool API

The publish tool is available only in a delegated session when `pullRequests` is configured and trusted deployment source checks pass. Its model-facing input is deliberately limited to pull request presentation:

```ts
{
  title: string; // 1–256 characters
  summary: string; // 1–10,000 characters
}
```

The tool derives the repository, base branch, deployed revision, prepared workspace, and replay-safe operation identifier from trusted configuration and session context. It does not accept a branch name, repository, base revision, file list, Git object ID, credential, or operation ID from the model.

On success it returns the configured base branch, generated namespaced branch, changed paths, commit SHA, deployed SHA, draft flag, pull request state, and pull request URL. The result describes a draft pull request only; the tool cannot merge, approve, close, retarget, or update the base branch.

## Isolated editing and publication

The model edits a per-session sandbox checkout. Checkout briefly enables a GitHub network policy that injects the PAT without putting it in a command or environment variable. The policy returns to deny-all before model editing begins. Publication resolves the PAT in the trusted application runtime; it never returns the token to the sandbox.

Proposal capture treats the sandbox as untrusted. It limits edits to the deployed application’s `agent/` directory, excludes generated configuration and build artifacts, rejects unsafe file kinds and malformed paths, and enforces file and byte limits. Repository-specific typechecking, tests, dependency installation, and preview builds belong in pull request CI.

The trusted publisher captures and validates the complete proposal before resolving the PAT. It may create Git objects, a branch under `eve-self-modification/`, and a draft pull request against the configured base. It cannot update the base branch, merge, approve, close, or retarget a pull request. A stable operation identifier makes retrying publication replay-safe.

## Setup and scaffolding

`eve add experimental/self-modification` generates `config.ts`. The scaffold makes draft-pull-request configuration an explicit, reviewable authoring decision instead of a collection of environment variables whose repository and branch settings can drift apart. Non-interactive installation leaves the default local-editing configuration intact.

Interactive setup detects and confirms the GitHub repository and base branch, writes `pullRequests.git`, and instructs the operator to set `EVE_SELF_MODIFICATION_GITHUB_TOKEN` in the deployment’s secret configuration. The shared configuration is then passed to the agent, sandbox, and extension, so they use the same repository and pull request target. Re-running setup may fill in missing generated configuration, but must not silently broaden an existing repository or branch selection.

The recommended credential is a fine-grained PAT restricted to the configured repository with Contents read and write, Pull requests read and write, and Metadata read. Setup never writes the PAT into source.

## Scope and limitations

The initial flow supports one GitHub repository and one base branch per definition. It does not support GitLab, Bitbucket, forks, coordinated multi-repository proposals, private package registry credentials, Git LFS content, networked pre-publication validation, deployment actions, or amending an existing proposal.

There is no self-modification-specific principal policy or in-session approval prompt. Every session accepted by an application with `pullRequests` configured can request a draft pull request. Applications must protect inbound routes and channels before enabling it.

## Future work

### GitHub App installation tokens

Replace the PAT with credentials from an existing GitHub App installation. An eve-owned adapter should discover the configured installation and mint repository-scoped installation tokens: a read-only token for checkout and a separately scoped write token for publication. This removes the PAT's unavoidable read/write overlap, so compromise of the checkout boundary cannot obtain write capability. Installation discovery, caching, refresh, and private-key handling must remain behind the adapter.

### Principal access policies

Add explicit allow policies over verified session principals. The policy must be checked when self-modification is exposed, before a sandbox is prepared, and again immediately before publication; a route-level authentication check alone is insufficient for a capability that opens pull requests. When a policy is configured, unmatched or absent principals must be denied. Setup can later help map channel-specific identities to those rules without making a model request an authority.

### Basic validation

Add an optional, bounded validation stage for the captured proposal before publication. The initial integrity checks remain mandatory and are not a substitute for application validation. A later scaffolded policy can allow a small, explicit set of safe checks—such as formatting, typechecking, or focused tests—and report their results on the draft pull request. Validation must run without publication credentials, have resource limits, and remain advisory rather than a reason to grant the sandbox more filesystem or network access. Full repository validation continues to belong in CI.

## Future exploration, not planned

The flow in this document is conversation-driven: the root agent delegates when a user asks for a persistent source change. It may infer that a request should persist, but it does not initiate self-modification without a conversational request.

Triggers and trigger prompts are a separate future area, not part of this plan. Possible signals include schedules, evaluations, CI failures, operational telemetry, or a detected source condition. Each would need an explicit triggering policy, a bounded prompt and input provenance, deduplication and rate limits, and an authorization model that establishes who or what may create a proposal. They must not turn an untrusted event payload or model observation into authority to modify source or publish a pull request.
