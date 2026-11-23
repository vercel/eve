---
title: "Self-Improvement"
description: "Run scheduled analysis, propose tested improvements, and report nightly decisions with @eve/self-improvement."
---

`@eve/self-improvement` is an optional extension for eve agents on Vercel. It
uses minimized Agent Runs telemetry and tool outcomes to find reproducible
problems, create tested GitHub PRs, and continue existing experiments. A quiet
night produces `no-findings` or `insufficient-evidence`, without an arbitrary PR.

The coordinator, analyst, and maintainer run through Vercel Workflow and Sandbox.
Private Vercel Blob stores observations, the experiment ledger, and recovery
state. The agent's chat model remains separate from its analyst and maintainer
models. Installing the package starts no job; mount it and deploy the host.

## Install and mount

Install it alongside eve:

```sh
pnpm add @eve/self-improvement
```

Add one mount and a telemetry policy:

```ts title="agent/extensions/self-improvement.ts"
import selfImprovement from "@eve/self-improvement";

export default selfImprovement({
  instance: "support",
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
  cron: "0 10 * * *",
});
```

```ts title="agent/instrumentation/otel.ts"
export { privateTelemetry as default } from "@eve/self-improvement/telemetry";
```

Merge the telemetry policy with existing host instrumentation when present.
The extension reads Agent Runs metadata and stores pseudonymized outcomes;
it does not fetch conversation transcripts or raw tool arguments. The cron
expression uses UTC, so a fixed expression shifts local time across DST.

## Connect services

Connect a **private Blob store** to the host project. It uses `BLOB_STORE_ID`
with project OIDC, or `BLOB_READ_WRITE_TOKEN`. The default setup needs no
Postgres service or driver. Postgres requires explicit `database` or `databaseUrl`;
environment variables never switch the backend.

Configure these additional secrets in the host environment:

| Variable                            | Access                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `EVE_SELF_IMPROVEMENT_HMAC_SECRET`  | At least 32 random characters for pseudonymizing identifiers and argument fingerprints                       |
| `EVE_SELF_IMPROVEMENT_GITHUB_TOKEN` | Repository read, contents/PR write, reviews/checks read, and normal merge authority when shipping is enabled |
| `EVE_SELF_IMPROVEMENT_VERCEL_TOKEN` | The configured team's Agent Runs, Sandbox, and deployment access                                             |

Trusted credential resolvers can supply short-lived tokens. Keep credentials
outside prompts and candidate processes. Repository signing, SSO, branch
protections, and required reviews still apply.

Proposal mode is the default. The maintainer edits code in a hosted sandbox and
publishes through the server's constrained signed-PR tool. Independent candidate
verification uses a fresh sandbox and the pinned package manager.

## Send nightly reports to Slack

Configure `report` on the mount with a trusted callback that sends through the
host agent's bot. It receives the date, decision, findings, PR/release links,
checks, and next-action reason. It runs for PR updates and no-change decisions.
Having a Slack channel installed does not configure this callback automatically.

Bind the authorized bot and recipient server-side. Use the supplied report `id`
as a stable delivery key, reconcile uncertain sends, and return a confirmed
`{ status: "sent" | "already-sent", id, url }` receipt. The callback owns message
formatting. Types are available from `@eve/self-improvement/core`.

## Verify the first occurrence

Deploy with [eve CLI](/docs/guides/deployment/vercel). As the configured owner,
ask the agent to call `self-improvement__doctor` with `sandbox: true`. Inspect
`self-improvement__status` for findings, PRs, exact heads, checks, and next actions.

Observe the next real scheduled occurrence: its runtime identity, cycle tool
call, completed coordinator, matching stored decision, and configured report
receipt. Setup checks remain pending until those actions run. A successful
schedule HTTP response alone does not prove the cycle completed.

## Enable automatic shipping

Set `policy.mode` to `"ship"` only after configuring the repository's required
checks, authenticated smoke test, changed-behavior proof, runtime inspection,
publisher verification, report callback, and trusted `release.deploy` service.
The release service runs eve CLI outside candidate/build sandboxes. The
controller verifies the deployed identity and preserves the known-good release
for rollback. Monitoring runs immediately and on later scheduled cycles.

See the [package README](https://github.com/vercel/eve/tree/main/packages/eve-self-improvement)
for callback contracts, retention settings, optional Postgres compatibility,
verification commands, and release recovery requirements.
