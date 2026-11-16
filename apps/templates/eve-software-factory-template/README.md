<img width="100%" alt="eve Software Factory Banner" src=".github/banner.png" />

# eve Software Factory Template

[![Docs](https://img.shields.io/badge/Documentation-000?style=flat-square&logo=readthedocs&logoColor=FFF&labelColor=000&color=000)](https://ask-foreman.dev/docs)
[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack)
[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Meet **Foreman**, an eve software factory that puts AI agents on every stage of the development loop and keeps people on the judgment calls.

Foreman takes tasks from GitHub, Linear, or an authenticated HTTP ticket API, triages them with a decision model, and delivers a reviewed draft pull request on your repository. You review, mark ready, and merge.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?demo-title=eve+Software+Factory&demo-description=Software+factory+built+on+eve%3A+AI+agents+work+each+stage+of+the+development+loop%2C+and+people+make+the+judgment+calls.&project-name=eve-software-factory&repository-name=eve-software-factory-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-software-factory-template&env=FACTORY_REPO%2CFACTORY_LABEL&envDefaults=%7B%22FACTORY_LABEL%22%3A%22factory%22%7D&envDescription=FACTORY_REPO+is+the+owner%2Frepo+the+factory+works+on.+FACTORY_LABEL+is+the+issue+label+that+hands+an+issue+to+the+factory%3B+the+default+label+is+fine.&connect=%5B%7B%22type%22%3A%22github%22%2C%22env%22%3A%22GITHUB_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fgithub%22%7D%2C%7B%22type%22%3A%22linear%22%2C%22env%22%3A%22LINEAR_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinear%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D&demo-image=%2F%2Fimages.ctfassets.net%2Fe5382hct74si%2F45PVqbeL5egwsqBRpGt6SQ%2F99e9f270dc22e07f499236af3a11a190%2Fimage.png&redirect-url=https%3A%2F%2Fask-foreman.dev%2Fwelcome)

## How it works

- **Triage** classifies the task, selects existing repository labels, checks likely duplicates, and chooses a lane in one decision-model call. The classifier station writes questions when clarification is needed.
- **Analyst** turns it into a plan with acceptance criteria, working from a live checkout of your repository.
- **Implementer** executes the plan in its own sandbox, verifies with your repo's own checks, and pushes a branch.
- **Reviewer** independently judges everything against the real diff, with evidence for each verdict.

Each station is its own agent with its own instructions, sandbox, and tools. The Reviewer sees only the pushed branch, never the Implementer's reasoning. Between runs, Foreman keeps a **factory brain**: notes about your repository that every run starts from. See [the pipeline](https://ask-foreman.dev/docs/pipeline) and [factory memory](https://ask-foreman.dev/docs/memory) for the full picture.

## How work arrives

- **Label an issue `factory`.** A label event from a GitHub-verified triage, write, maintain, or admin user on `FACTORY_REPO` can start the unattended pipeline once per issue. It posts progress as stations complete and ends with a draft PR linked to the issue.
- **@mention it on an issue or PR.** Mentions start an interactive session only after GitHub verifies write, maintain, or admin permission on `FACTORY_REPO`.
- **Delegate in Linear.** Agent Sessions from `LINEAR_WORKSPACE_ID` run the same pipeline and report progress back in Linear; other workspaces are rejected.
- **HTTP tickets.** Submit a work item to `POST /intake/v1/tickets` with the configured intake bearer; poll its status with the same bearer. See [HTTP intake](#http-intake).
- **The dev TUI.** Hand it a task locally. Changes to GitHub wait for your approval.
- **Red CI on a factory PR.** Foreman reads fresh failure evidence and classifies it before spending a revision cycle. Only code failures proceed to a fix; missing logs, infrastructure, configuration, and flaky failures stop for a person.
  Automatic PR-open summaries are disabled. Public PR content cannot start a session with the factory's privileged tools. GitHub sessions cannot use the app-scoped Linear connection, including read tools; delegate from the configured Linear workspace instead.

### Label intake and retries

The pinned published eve release exposes an issue's current labels, not which label changed. Intake therefore accepts the first authorized `labeled` event whose issue contains `FACTORY_LABEL`, including labels attached at creation. For an existing, never-claimed labeled issue, adding another label can also trigger its first intake. Later unrelated labels, webhook redeliveries, and removing and re-adding the factory label cannot restart it.

Before dispatch, the channel atomically creates a private, write-once Blob claim at `issue-intake/<lowercase-owner>/<lowercase-repo>/<issue-number>.md`. Claims persist across sessions and deployments sharing that store. This is at-most-once automatic intake, not guaranteed delivery: if the process stops after claiming but before starting a session, automatic delivery is lost. Storage errors (including uncertain write results) fail closed without dispatch; they are acknowledged, not automatically retried by the template. Claims are never automatically removed, even after a failed or completed run. To retry, requeue, or answer clarification questions, a repository writer must explicitly @mention the bot on the issue. Do not delete claims to requeue, since an old webhook delivery could then start another run. Retain the claim prefix when migrating stores; losing claims resets automatic intake history.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?demo-title=eve+Software+Factory&demo-description=Software+factory+built+on+eve%3A+AI+agents+work+each+stage+of+the+development+loop%2C+and+people+make+the+judgment+calls.&project-name=eve-software-factory&repository-name=eve-software-factory-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-software-factory-template&env=FACTORY_REPO%2CFACTORY_LABEL&envDefaults=%7B%22FACTORY_LABEL%22%3A%22factory%22%7D&envDescription=FACTORY_REPO+is+the+owner%2Frepo+the+factory+works+on.+FACTORY_LABEL+is+the+issue+label+that+hands+an+issue+to+the+factory%3B+the+default+label+is+fine.&connect=%5B%7B%22type%22%3A%22github%22%2C%22env%22%3A%22GITHUB_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fgithub%22%7D%2C%7B%22type%22%3A%22linear%22%2C%22env%22%3A%22LINEAR_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinear%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D&demo-image=%2F%2Fimages.ctfassets.net%2Fe5382hct74si%2F45PVqbeL5egwsqBRpGt6SQ%2F99e9f270dc22e07f499236af3a11a190%2Fimage.png&redirect-url=https%3A%2F%2Fask-foreman.dev%2Fwelcome)

The Vercel deploy flow sets up everything: the **GitHub** connector, **Linear** connector, a **private Vercel Blob** store, and a prompt for the `FACTORY_REPO` and `FACTORY_LABEL` environment variables.

Existing deployments must replace public stores with private stores and remove old public documents. Updating the app does not revoke existing public URLs.

Two things must line up before Foreman can do any real work. `FACTORY_REPO` must name a real repository in `owner/repo` format, and the GitHub App behind the connector you select must be installed with access to that repository. A station's sandbox clones `FACTORY_REPO` on its first session, not at deploy time, so a repository the app cannot reach surfaces as a repository-access error on the first task you hand it, not the deploy itself; install the app on the repository (or fix the value), then try again.

GitHub extension tools request App installation tokens narrowed to `FACTORY_REPO`, including code and issue searches whose query has no repository qualifier. This token restriction prevents access to other private repositories even when the Connect installation covers them. Repository guardrails also reject explicit tool targets outside `FACTORY_REPO`.

Authenticated Git operations run in fresh disposable transfer sandboxes, never in the stations that execute repository code. Only bounded Git object bundles cross that boundary, without hooks, configuration, executables, or background processes. Pushes target one `FACTORY_BRANCH_PREFIX` ref, refuse the repository's actual default branch and protected branches, and never force-push. Keep GitHub branch protection enabled as defense in depth.

Each transfer has a 120-second sandbox lifetime and a 64 MiB bundle limit. Transfers include the selected branch's full history; larger repositories fail closed instead of falling back to credentialed station commands. The channel's built-in credentialed checkout is disabled. Set `LINEAR_WORKSPACE_ID` to the organization ID of the connected Linear workspace to enable its intake and MCP tools; leaving it unset disables both. Remove or restart existing sessions when upgrading so old auth and checkout state do not survive the authorization change.

### Sandbox defaults

Root and repository stations start with egress restricted to GitHub and public package registries. Add exact hostnames with `FACTORY_SANDBOX_ALLOWED_DOMAINS`; use `FACTORY_SANDBOX_EGRESS=open` only when unrestricted access is necessary. Allowed hosts can still receive repository data, so this is destination restriction, not a confidentiality guarantee. These options never widen the credentialed transfer sandbox's GitHub-only policy. Restart existing sessions to apply a changed policy.

Tooling preparation checks Git and installs pnpm 11.25.0 if pnpm is absent, before repository data enters the snapshot. Session setup disables automatic npm, pnpm, and Yarn install scripts before running `FACTORY_SETUP_COMMAND`. Explicit commands such as `pnpm run generate` still run. Prefer naming a required generation step explicitly; `FACTORY_ALLOW_INSTALL_SCRIPTS=1` opts into automatic scripts for new sessions. Package-manager settings are defaults, not a security boundary against repository code with a shell.

Configuration (see `.env.example`):

| Variable                                | Required   | Default               | What it does                                                                                                                                     |
| --------------------------------------- | ---------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FACTORY_REPO`                          | Yes        | —                     | An existing GitHub repository in `owner/repo` format; the selected GitHub App must have access to it (a station's first session fails otherwise) |
| `LINEAR_WORKSPACE_ID`                   | For Linear | —                     | Connected Linear organization ID; intake and app-scoped tools fail closed when unset or mismatched                                               |
| `FACTORY_SETUP_COMMAND`                 | No         | —                     | Runs once per session inside the station sandbox checkout (e.g. `pnpm install`), so the station starts with dependencies already installed       |
| `FACTORY_SANDBOX_ALLOWED_DOMAINS`       | No         | —                     | Comma-separated extra exact hostnames; no schemes, ports, paths, IPs, or wildcards; at most 64                                                   |
| `FACTORY_SANDBOX_EGRESS`                | No         | restricted            | `open` permits all destinations in root and station sandboxes                                                                                    |
| `FACTORY_ALLOW_INSTALL_SCRIPTS`         | No         | off                   | `1` permits automatic package install scripts                                                                                                    |
| `FACTORY_INTAKE_TOKEN`                  | For HTTP   | —                     | Dedicated 32–4096-character bearer; unset disables HTTP intake                                                                                   |
| `FACTORY_LABEL`                         | No         | `factory`             | The issue label that hands an issue to the factory                                                                                               |
| `FACTORY_BRANCH_PREFIX`                 | No         | `factory/`            | Branch prefix marking the factory's own PRs, which are the only branches automated CI fixes touch                                                |
| `FACTORY_BOT_NAME`                      | No         | the GitHub App's slug | The `@mention` name, resolved from the connector automatically when unset                                                                        |
| `GITHUB_CONNECTOR` / `LINEAR_CONNECTOR` | Yes        | —                     | Set automatically from Vercel Connect connector UIDs                                                                                             |

## HTTP intake

Set `FACTORY_INTAKE_TOKEN` to a dedicated secret of at least 32 characters, managed through your deployment environment. Only that bearer authenticates these routes: project OIDC and local-dev credentials are not fallbacks. Everyone sharing the bearer shares its ticket address space. Rotating the bearer makes its old tickets inaccessible through this API.

```bash
curl "$FACTORY_URL/intake/v1/tickets" \
  -H "Authorization: Bearer $FACTORY_INTAKE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"externalId":"support-123","title":"Duplicate email delivery","body":"Alice receives two reset emails for one request. Investigate and add a regression test."}'
```

A successful submission returns `202` with `ticketId`. Poll `GET /intake/v1/tickets/:ticketId` with the same bearer for `status`, `result`, and `sessionEnded`. The run is unattended and can deliver draft PRs, but cannot comment on GitHub threads, change issue or PR labels or state, or write shared memory. Clarification ends the run with questions; submit answers as a new ticket with a new `externalId`.

The strict request schema requires `title` (up to 300 characters) and `body` (up to 20,000). Optional fields are `externalId` (200), `source` (100), `requester` (200), `priority` (`low`, `normal`, `high`, or `urgent`), and at most 20 `labels` (50 characters each). Metadata is single-line untrusted text, not identity or authority. Unknown fields, including `callbackUrl`, are rejected. Requests are capped at 64 KiB and 15 seconds of body reading; status reads stop after 4 MiB, 4,096 events, or 15 seconds. Responses are capped at 64 KiB, with final text limited to 16,000 characters.

The same bearer and `externalId` identify the same ticket. A live session returns `200` with `duplicate: true`. A permanent private Blob claim prevents a second dispatch even after the session ends or disappears. `409 intake_not_claimed` means the claim already exists or storage could not confirm it; `503 dispatch_failed` means dispatch failed after claiming. Both fail closed: submit a new `externalId` to retry deliberately. Without `externalId`, each submission is a new ticket. Keep `ticket-intake/` claims when migrating stores, just like `issue-intake/` claims. Callbacks are not supported.

## Local development

Link the project you deployed (or a fresh one), pull its environment, and start the TUI:

```bash
vercel link
vercel env pull
pnpm dev
```

Hand the agent a task ("users report the password reset email arrives twice, fix it") and watch triage and the three change stations run in order, ending in a draft PR on `FACTORY_REPO`. Local runs are treated as untrusted, so changes to GitHub wait for your approval in the TUI.

`pnpm validate` runs formatting/lint checks, TypeScript, offline regression tests, and discovery with zero errors or warnings. The standalone workflow in `.github/workflows/ci.yml` splits those checks and tests Node 24/26; GitHub only executes it when this template is a repository root. Live sandboxes, model calls, builds, and full-pipeline evals require deployment credentials and a scratch repository.

## Resources

- [Foreman Docs](https://ask-foreman.dev/docs)
- [Vercel Connect](https://vercel.com/docs/connect)
- [eve Documentation](https://eve.dev/docs/introduction)
- [GitHub Tools eve Extension](https://github-tools.com/frameworks/eve-extension)

## Explore more templates

- [eve Marketing Team](https://vercel.com/templates/eve/eve-marketing-team)
- [eve Personal Agent](https://vercel.com/templates/nuxt/eve-personal-agent)
- [eve Sanity Copilot](https://vercel.com/templates/eve/eve-sanity-copilot)
