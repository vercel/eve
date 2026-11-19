# @eve/self-improvement

An installable eve extension that turns observed failures into tested source changes. It includes a Vercel-hosted coordinator, analyst and coding agent, private evidence/experiment storage, signed PR publishing, review reconciliation, release verification and rollback. Automatic shipping connects to your trusted release service; coding needs no desktop runner or GitHub Actions.

Capability, correctness, UX, reliability and performance come first. Cost is telemetry, not the objective. Sparse traffic can produce `insufficient-evidence` or `no-findings`; neither creates an arbitrary PR.

## Install

The consumer installs one compiled package and adds two small files: the extension mount and the telemetry policy below. Tests, development tools and the development lockfile stay in this package's source repository; they are not installed as part of the extension. Runtime dependencies are `@vercel/sandbox`, `@vercel/oidc` and `zod`; the host supplies eve. The Blob adapter is compiled into the package. Postgres compatibility is an optional adapter: install `pg` only when selecting it.

The host supplies eve 1.1.0 or newer. Use the package manager for your agent:

```sh
pnpm add @eve/self-improvement
```

The published package contains compiled contributions and declarations. Its build
records the exact authoring eve version; the host must support that version and
distribution contract. Package releases follow the eve repository release process.

Mount it once:

```ts
// agent/extensions/evolution.ts
import evolution from "@eve/self-improvement";

export default evolution({
  instance: "support",
  database: "blob",
  project: {
    teamId: "team_YOUR_TEAM_ID",
    projectId: "prj_YOUR_PROJECT_ID",
    productionUrl: "https://your-agent.example.com",
  },
  repository: { owner: "your-org", name: "your-agent", branch: "main" },
  owner: { authenticator: "your-authenticator", principalId: "your-owner-id" },
  models: {
    analyst: "openai/gpt-6.1-sol-fast",
    maintainer: "openai/gpt-6.1-sol",
  },
  cron: "0 10 * * *", // UTC. Fixed UTC cron shifts local time across DST.
});
```

The two model IDs illustrate separate roles; choose them using your own capability/latency evaluations. For custom eve model handles, use `{ model: handle, modelContextWindowTokens: <actual context window> }`; this also supports `mockModel` in isolated fixtures. Your chat model remains the host's choice. A monorepo can set `repository.directory` to the application path. Keep `instance` and the mount name stable; they identify private state.

### Connect the required services

Execution uses Vercel Workflow, Sandbox and Schedules; telemetry comes from Vercel Agent Runs and model routing uses AI Gateway. Source changes and PRs use GitHub, and private evidence/state defaults to Vercel Blob. This release implements GitHub's source/review/check APIs; another forge needs an adapter.

Connect a **private Vercel Blob store** to the host project. The SDK uses `BLOB_STORE_ID` with project OIDC, or `BLOB_READ_WRITE_TOKEN`. All reads bypass the CDN cache; conditional writes protect the lease and atomically save the active experiment with its history. No database setup is needed. Installing the package does not provision services.

Postgres remains optional. Install `pg@^8.23.1` when selecting either Postgres backend. To reuse the first-party **Vercel Postgres alpha**, add `database: "vercel-postgres"` to the mount and use the project's `PGHOST` / `PGPORT` / `PGUSER` / `PGDATABASE` settings. Connections use verified TLS and a fresh project-scoped Vercel OIDC password callback, with rotating connections. No Marketplace database or stored database password is needed for that path. Load the project environment for local checks; this package has no hardcoded demo database host.

For other PostgreSQL deployments, use `database: "postgres"` and provide `EVE_EVOLUTION_DATABASE_URL`, `POSTGRES_URL` or `DATABASE_URL`. An explicit URL takes precedence. Existing `database` / `databaseUrl` settings and Postgres URL environment variables continue selecting Postgres, preserving its history. Set `database: "blob"` explicitly when the host has an unrelated database. Switching backends starts a separate ledger; there is no automatic data migration or fallback on errors.

Configure secrets on the host, never in prompts or committed files:

| Variable                                                   | Purpose                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `BLOB_STORE_ID` + project OIDC, or `BLOB_READ_WRITE_TOKEN` | Access to a private Blob store (default backend)                                     |
| `PG*` settings or a Postgres URL                           | Only for the optional Postgres backend; permission to create `eve_evolution_records` |
| `EVE_EVOLUTION_HMAC_SECRET`                                | At least 32 random characters for identifier/argument pseudonyms                     |
| `EVE_EVOLUTION_GITHUB_TOKEN`                               | Repository read, contents/PR write, reviews/checks read and normal merge authority   |
| `EVE_EVOLUTION_VERCEL_TOKEN`                               | Configured Vercel team's Agent Runs, Sandbox and deployment/rollback access          |

For short-lived credentials, supply `credentials.github` / `credentials.vercel` callbacks instead. `databaseUrl` and `privacy.hmacSecret` also accept trusted resolvers. Prefer a repository-scoped installation identity. Git/Vercel SSO, organization restrictions, publisher onboarding and branch policies still apply.

For minimized OTel export, add or merge this policy into the host's existing instrumentation:

```ts
// agent/instrumentation/otel.ts
export { privateTelemetry as default } from "@eve/self-improvement/telemetry";
```

Instrumentation belongs to the host because eve extension roots cannot declare it. eve exports Agent Runs in hosted preview/production by default; do not disable that destination. The extension reads Agent Runs **metadata**, never `trace=1`, titles, prompts or raw arguments. Its hooks add pseudonymized tool/turn outcomes, measured latency and explicit feedback. Default retention is 7 days for observations and 90 for experiment/report history; `privacy.retentionDays` / `ledgerDays` configure it. Expired evidence is excluded immediately and physically deleted by scheduled purges; Blob TTL adds a cleanup backstop. Each observation keeps its original expiry across retries and retention-setting changes. The active recovery record remains until reconciled.

## Verify setup

Start with the default `propose` mode: configure the services above, deploy the host with eve CLI, then verify readiness. This mode can analyze evidence and create tested draft PRs. Automatic merging/deployment is an additional setup step described below.

As the configured authenticated owner, ask the agent to call `evolution__doctor` with `sandbox: true`. After configuring the checks below, also use `production: true`. It tests identity/linkage, metadata access, storage/deletion and a real hosted checkout. `evolution__status` shows pending PRs, exact heads, gates and next actions.

Checks distinguish **passed**, **failed**, **unavailable** and **pending**. A natural scheduled occurrence is pending until an actual app session calls the cycle, the coordinator finishes, and the matching decision is stored. Read-only permissions do not prove a signed PR, deployment or rollback executed. Use Vercel Schedules/Workflow/Sandbox observability for private diagnostics; cron HTTP 200 and Slack receipts alone do not establish health.

The schedule calls `evolution__cycle`, which authorizes its real app identity and returns a coordinator delegation when needed. The coordinator's tools enforce a durable state machine; eve hosts its sessions on Vercel Workflow. Recorded runtime call facts prevent task start receipts from completing a stage or releasing its lease. Conditional Blob writes or Postgres leases/fences prevent overlapping work, deterministic branches reconcile uncertain publication, and each schedule resumes an interrupted PR/release. External reviews can remain pending until the next run. Ordinary chat, forged schedule text and other principals cannot start privileged evolution. Personal task schedules are untouched.

## Verify candidates and enable shipping

The default policy is `propose`. The hosted maintainer already checks out code, edits/tests it in Vercel Sandbox and publishes a signed draft PR. GitHub tokens stay at the firewall/server; candidate processes receive no production credentials. The publisher supports ordinary non-executable files and refuses secrets, internal runtime directories, workflow files and configured `policy.protectedPaths`. Native signing is needed for executable/symlink/mode changes.

Independent verification checks the **published head** in a fresh sandbox: a clean install with the exact `packageManager`, existing typecheck/test/build scripts and `build:web` when present. Set `verification.commands` if your script names differ. Candidate-reported test results cannot satisfy this gate.

User-visible regressions need an application-specific executable proof. Configure:

```ts
verification: {
  authHeaders: async environment => loadPrivateEvalHeaders(environment),
  smoke: {
    message: "Call calculate for 19 * 23. Return the result.",
    toolName: "calculate",
    expectedOutput: { result: 437 },
  },
  change: verifyChangedBehavior,
  runtime: inspectFreshRuntimeAndBehavior,
  publisher: verifyPublisherSnapshot,
  // Optional: verify the host's bot delivery with a stable ID and receipt.
  delivery: verifyBotDelivery,
},
report: deliverPrivateMaintenanceReport,
release: { deploy: deployWithTrustedEveCli },
policy: {
  mode: "ship",
  requiredChecks: [/* exact required check contexts for this repository */],
},
```

The verification/report callbacks supply project-specific **evidence**. Their interfaces are exported from `@eve/self-improvement/core`:

- `change({ baseline, candidate, preview })` returns `{ head, status, reason }`, optionally real before/after `metrics`. It must exercise the claimed behavior on the exact verified preview. A reproducible bug can use a deterministic regression; population claims need at least 20 comparable samples per cohort.
- `runtime({ deployment, baseline })` returns `{ deploymentId, status, reason, causedByRelease? }` after inspecting actual runtime errors and changed behavior. An unrelated provider failure is insufficient for `causedByRelease: true`.
- `publisher({ sha, deployment })` verifies the publisher/repository snapshot against the merged source and returns a `Check`.
- `delivery({ id, deployment })` and `report(report)` return `{ status: "sent" | "already-sent", id, url }`. Bind sender/recipient on the server, reconcile timeouts with the same ID, and return a confirmed receipt/permalink. Reporting is required for shipping so rollback blockers have an alert route. Bot/channel choice remains the host's; no recipient is hardcoded.

`release.deploy({ sha, project, repository })` is a separate trusted execution boundary. Connect an existing hosted release service that runs eve CLI for the exact merged SHA and configured team/project, preserves lockfiles and old deployments, and reconciles uncertain outcomes. Never implement it by granting publisher/API credentials to a sandbox that runs candidate code or dependency hooks: background processes can use firewall-injected credentials too. The controller sends no credentials in this request and independently verifies the deployed identity and publisher snapshot. Without this executor the extension can propose, but cannot merge for shipping.

The extension confirms an immutable preview's exact team/project/SHA/environment **before** requesting evaluation auth. It reads conversation comments, submitted/inline reviews, unresolved threads, check output and annotations after every push, even when checks pass or skip. The analyst classifies actionable feedback; fixes stay on the same branch and get a new verification/review round. Addressed observed threads resolve only after independent tests. Drafts become ready automatically when verified; repository-required approvals remain enforced.

Merge requires the exact verified head, all configured checks succeeding, current base, resolved conversations and GitHub's enforced merge policy. Cost savings alone never qualify a candidate. When actual comparable metrics exist, quality/corrections/failures cannot regress, p95 latency may rise at most 5%, and the target must improve at least 10%. Missing samples/pricing are unavailable, not zero or fabricated passes.

Before release, the controller stores and verifies the known-good deployment, immutable URL, SHA and health/runtime baseline. The trusted release service deploys merged main through **eve CLI**; the controller verifies production identity, a fresh authenticated tool event, changed behavior/runtime, publisher identity and configured bot receipt. Monitoring runs immediately and on later schedules, including unchanged days.

A confirmed release regression triggers Vercel's supported rollback to the saved deployment, recovery checks and a signed revert PR through normal checks. Uncertain publishing, deployment, rollback and report outcomes are reconciled before retries. A blocked rollback stops releases and reports urgently. If source advanced or revert conflicts, the ledger preserves that blocker rather than overwriting main. For stronger separation, run the controller in a separately governed agent/project so candidates cannot alter its deployed policy.

## Develop and test

```sh
pnpm install --frozen-lockfile
pnpm --filter @eve/self-improvement typecheck
pnpm --filter @eve/self-improvement test
pnpm --filter @eve/self-improvement build
pnpm --filter @eve/self-improvement test:scenario
```

`pnpm --filter @eve/self-improvement test:blob <consumer-directory>` exercises real Blob concurrency, recovery, anonymous-read rejection and physical deletion with private store credentials, then removes its synthetic namespace.

The tests exercise privacy, source pagination, waiting sessions, quality gates, auth isolation, signed-head checks, publishing/rollback recovery and Blob lease/retention/recovery behavior, plus real Postgres SQL using an isolated embedded PostgreSQL engine. Set `EVE_EVOLUTION_TEST_DATABASE_URL` to run against a disposable native PostgreSQL database. Synthetic fixtures are isolated from production statistics.

`test:scenario` installs a packed tarball and the built workspace eve package
with a clean npm install in a fresh app, then compiles every contribution.
It verifies installation without the optional Postgres driver. The offline build
skips Sandbox prewarming; its output is not deployable. Set
`EVE_EVOLUTION_HOSTED_CONSUMER=1` with private Vercel Sandbox credentials to
exercise template preparation. Actual checkout is tested by
`doctor({sandbox:true})`. The independent verifier opens a fresh Sandbox SDK
instance, separate from the maintainer's eve session.

To verify local runtime authorization and recovery, retain a consumer with `EVE_EVOLUTION_KEEP_CONSUMER=1 pnpm --filter @eve/self-improvement test:scenario`, then run `pnpm --filter @eve/self-improvement test:runtime <retained-consumer-directory>` with private Blob credentials. Set `EVE_EVOLUTION_TEST_DATABASE_URL` instead to exercise disposable Postgres. It uses real eve dispatch/tools/hooks with labeled model/provider fixtures, disables OTel export and deletes only its random synthetic namespace afterward.

For a real maintainer checkout/edit/test, also set `EVE_EVOLUTION_TEST_HOSTED_CONFIG` to JSON `{project:{teamId,projectId},repository:{owner,name},sha:<full immutable SHA>}`, plus private `EVE_EVOLUTION_GITHUB_TOKEN` and Vercel Sandbox credentials. This only edits a disposable sandbox, deliberately never publishes, and stops the maintainer's compute after its turn. Without the hosted option, only private storage credentials are needed.

No service, schedule or production migration starts merely by unpacking this archive. Install/mount it, configure identities and evidence, deploy with `eve link` / `eve deploy`, then observe the next real occurrence. `doctor` keeps unobserved provider/production checks pending.

## Source

This package is developed in the public [eve repository](https://github.com/vercel/eve/tree/main/packages/eve-self-improvement) and released as `@eve/self-improvement`.
