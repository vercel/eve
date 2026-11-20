import { isScheduleAuth } from "eve/schedules";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import extension from "../extension.js";
import { digest, hmacSecret, namespace, type Config } from "./config.js";
import { rankFindings, summarizeUsage } from "./analyze.js";
import { readAgentRuns } from "./agent-runs.js";
import { allPassed } from "./gates.js";
import { createHostedRunner } from "./hosted.js";
import { boundFeedback, GitHub, Vercel } from "./providers.js";
import {
  inspectCandidate,
  markReady,
  mergeExact,
  reviewFingerprint,
  reconcileBaseUpdate,
} from "./review.js";
import { receiptValid, verifyChange, verifyRelease } from "./verify.js";
import { store } from "./store.js";
import type { Active, Check, Experiment, Lease, Report } from "./types.js";
import { createRevert } from "./revert.js";
import { reconcilePublication } from "./publish.js";
import { monitorRelease } from "./monitor.js";

export type Action = {
  action: "done" | "wait" | "code" | "analyze" | "review";
  lease?: Lease;
  payload?: string;
  report?: Report;
  prefix?: string;
};
const hypothesis = z.object({
  findingId: z.string(),
  hypothesis: z.string().min(1).max(4000),
  change: z.string().min(1).max(4000),
  regression: z.string().min(1).max(4000),
});
const reviewDecision = z.object({
  action: z.enum(["fix", "accept", "wait"]),
  reason: z.string().min(1).max(4000),
});
const terminal = new Set(["shipped", "rejected", "rolled-back"]);
const date = () => new Date().toISOString().slice(0, 10);
function parseJson(text: string): unknown {
  return JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
}
export function authorizeCycle(ctx: Pick<ToolContext, "session" | "toolName">): string {
  const prefix = ctx.toolName.slice(0, -"cycle".length);
  if (
    !ctx.toolName.endsWith("__cycle") ||
    !isScheduleAuth(ctx.session.auth.current) ||
    ctx.session.parent ||
    ctx.session.schedule?.definition !== `${prefix}daily`
  )
    throw new Error("Evolution requires its real app schedule; message claims do not authorize it");
  return prefix;
}
export async function bindings(c: Config): Promise<Check> {
  const git = new GitHub(c),
    platform = new Vercel(c);
  const [repo, project] = await Promise.all([
    git.api(`/repos/${git.repo}`),
    platform.api(`/v9/projects/${c.project.projectId}`),
  ]);
  if (
    project.id !== c.project.projectId ||
    project.accountId !== c.project.teamId ||
    String(project.link?.repoId) !== String(repo.id) ||
    repo.full_name?.toLowerCase() !== git.repo.toLowerCase()
  )
    throw new Error(
      "GitHub repository identity and Vercel Git linkage do not match the configured project/team",
    );
  return {
    name: "repository and Vercel bindings",
    status: "passed",
    reason: "Verified repository ID, Vercel team/project and Git linkage",
  };
}
function reportFor(
  experiment: Experiment | null,
  status: string,
  checks: Check[] = [],
  findings = experiment ? [experiment.finding] : [],
): Report {
  const id = experiment?.reason?.startsWith("URGENT:")
    ? `alert:${namespace(extension.config)}:${experiment.id}:rollback`
    : `daily:${namespace(extension.config)}:${date()}`;
  return {
    id,
    date: date(),
    status,
    checks,
    findings,
    experiment: experiment
      ? {
          id: experiment.id,
          status: experiment.status,
          reason: experiment.reason,
          candidate: experiment.candidate,
          release: experiment.release,
        }
      : undefined,
  };
}
async function save(c: Config, active: Active): Promise<void> {
  if (active.experiment?.feedback)
    active.experiment.feedback = boundFeedback(active.experiment.feedback);
  if (active.experiment) active.experiment.updatedAt = Date.now();
  await store(c).save(active.lease, active.experiment);
}
export async function prepare(
  ctx: Pick<ToolContext, "session" | "toolName" | "callId">,
): Promise<Action> {
  const prefix = authorizeCycle(ctx),
    c = extension.config,
    db = store(c);
  hmacSecret(c);
  const active = await db.acquire(`${ctx.session.id}:${ctx.callId}`);
  if (!active) return { action: "done", report: reportFor(null, "already-running") };
  try {
    await db.purge();
    await bindings(c);

    if (active.experiment?.status === "shipped" && active.experiment.release?.deployment)
      await db.put("release:last", active.experiment);
    const previous = await db.get<Experiment>("release:last");
    if (
      previous?.release?.deployment &&
      !previous.release.rollback &&
      active.experiment?.status !== "rolled-back" &&
      (!active.experiment || terminal.has(active.experiment.status) || !active.experiment.release)
    ) {
      const monitoredPrevious = await monitorRelease(c, previous);
      if (monitoredPrevious.status !== "shipped") {
        if (
          active.experiment &&
          active.experiment.id !== monitoredPrevious.id &&
          !terminal.has(active.experiment.status)
        )
          await db.put("resume:experiment", active.experiment);
        active.experiment = monitoredPrevious;
        await save(c, active);
      }
      await db.put("release:last", monitoredPrevious);
    }
    if (
      active.experiment &&
      terminal.has(active.experiment.status) &&
      active.experiment.status !== "rolled-back"
    ) {
      const pending = await db.get<Experiment>("resume:experiment");
      if (
        ((pending && pending.id !== active.experiment.id) ||
          active.experiment.id.startsWith("revert-")) &&
        active.experiment.status !== "shipped"
      ) {
        active.experiment.status = "blocked";
        active.experiment.reason =
          "Recovery has not shipped; new experiments and releases remain blocked";
        await save(c, active);
        return {
          action: "done",
          lease: active.lease,
          report: reportFor(active.experiment, "recovery-blocked"),
        };
      }
      active.experiment = pending?.id !== active.experiment.id ? pending : null;
      await save(c, active);
      if (pending) await db.put("resume:experiment", null);
    }
    if (active.experiment) {
      active.experiment.rootSession = ctx.session.id;
      active.experiment.coordinatorSession = undefined;
      active.experiment.writerSession = undefined;
      if (active.experiment.status === "coding" && active.experiment.publishIntent)
        await reconcilePublication(c, active as Active & { experiment: Experiment });
      await db.put("occurrence:last", {
        session: ctx.session.id,
        definition: ctx.session.schedule!.definition,
        analysisId: `analysis:${date()}`,
        settled: false,
      });
      await save(c, active);
      const action =
        active.experiment.status === "analyzing"
          ? "analyze"
          : active.experiment.status === "coding" || !active.experiment.candidate
            ? "code"
            : "wait";
      return { action, lease: active.lease, prefix, payload: JSON.stringify(active.experiment) };
    }
    const analysisId = `analysis:${date()}`;
    const existing = await db.get<Report>(analysisId);
    if (existing) {
      await db.release(active.lease);
      return { action: "done", report: existing };
    }
    const end = Math.floor(Date.now() / 1000) - 120;
    const evidence = await readAgentRuns(c, { from: end - 86400, to: end });
    const observations = await db.observations((end - 86400) * 1000, end * 1000);
    evidence.observations = observations.complete ? observations.values : [];
    evidence.observationsComplete = observations.complete && observations.values.length > 0;
    if (!observations.complete) {
      evidence.reasons.push("Turn telemetry query was truncated");
    }
    const findings = rankFindings(evidence);
    const base = await new GitHub(c).main();
    let selected;
    for (const finding of findings)
      if (!(await db.get(`experiment:${digest([finding.id, base]).slice(0, 24)}`))) {
        selected = finding;
        break;
      }
    await db.put("occurrence:last", {
      session: ctx.session.id,
      definition: ctx.session.schedule!.definition,
      analysisId,
      settled: false,
    });
    if (!selected) {
      const status =
        !evidence.complete || (!evidence.observationsComplete && !findings.length)
          ? "insufficient-evidence"
          : "no-findings";
      const report = reportFor(
        null,
        status,
        [
          {
            name: "Agent Runs metadata",
            status: evidence.complete ? "passed" : "unavailable",
            reason:
              evidence.reasons.join("; ") ||
              "Complete fixed-window metadata query; no transcripts fetched",
          },
          {
            name: "UX/turn evidence",
            status: evidence.observationsComplete ? "passed" : "unavailable",
            reason: `${observations.values.length} minimized observations; absence of feedback is not proof of task success`,
          },
        ],
        findings,
      );
      report.usage = summarizeUsage(evidence);
      await db.put(analysisId, report);
      await db.release(active.lease);
      return { action: "done", report };
    }
    active.experiment = {
      id: digest([selected.id, base]).slice(0, 24),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rootSession: ctx.session.id,
      status: "analyzing",
      base,
      finding: selected,
      attempts: 0,
      checks: [],
    };
    await save(c, active);
    await db.put(analysisId, reportFor(active.experiment, "analyzing"));

    return {
      action: "analyze",
      lease: active.lease,
      prefix,
      payload: JSON.stringify({
        experiment: active.experiment,
        source: {
          window: evidence.window,
          complete: evidence.complete,
          observationsComplete: evidence.observationsComplete,
        },
        history: (await db.list<Experiment>("experiment:", 100)).map((e) => ({
          id: e.id,
          finding: e.finding,
          status: e.status,
          reason: e.reason,
        })),
      }),
    };
  } catch {
    await db.release(active.lease);
    return {
      action: "done",
      report: reportFor(active.experiment, "setup-blocked", [
        {
          name: "hosted setup",
          status: "failed",
          reason:
            "Bindings, durable storage or metadata access failed; inspect private provider/setup logs. No authorization was bypassed.",
        },
      ]),
    };
  }
}
async function current(c: Config, lease: Lease): Promise<Active & { experiment: Experiment }> {
  const active = await store(c).active();
  if (
    !active?.experiment ||
    active.lease.owner !== lease.owner ||
    active.lease.fence !== lease.fence ||
    active.lease.until <= Date.now()
  )
    throw new Error("Evolution lease lost; stop and reconcile");
  await store(c).renew(lease);
  return active as Active & { experiment: Experiment };
}
export async function acceptAnalysis(lease: Lease, text: string): Promise<Action> {
  const c = extension.config,
    active = await current(c, lease),
    e = active.experiment;
  const plan = hypothesis.parse(parseJson(text));
  if (plan.findingId !== e.finding.id)
    throw new Error("Analyst hypothesis names a different finding");
  e.hypothesis = plan;
  e.status = "coding";
  e.writerSession = undefined;
  e.attempts++;
  await save(c, active);
  return { action: "code", lease, payload: JSON.stringify(e) };
}
export async function codingComplete(lease: Lease, reply: string): Promise<void> {
  const c = extension.config,
    active = await current(c, lease),
    e = active.experiment;
  if (e.status === "coding") {
    if (e.publishIntent && (await reconcilePublication(c, active))) return;
    e.status = e.candidate ? "blocked" : "rejected";
    e.reason = `Maintainer did not publish a new executable candidate: ${reply.slice(0, 1000)}`;
    await save(c, active);
  }
}
export async function acceptReview(lease: Lease, text: string): Promise<Action> {
  const c = extension.config,
    active = await current(c, lease),
    e = active.experiment;
  const decision = reviewDecision.parse(parseJson(text));
  if (decision.action === "fix") {
    if (e.attempts >= c.policy.maxAttempts) {
      e.status = "blocked";
      e.reason =
        "Bounded coding attempts exhausted; preserve this PR/head and investigate before retrying";
    } else {
      e.status = "coding";
      e.reason = decision.reason;
      e.writerSession = undefined;
      e.publishIntent = undefined;
      e.attempts++;
    }
  } else if (decision.action === "accept") e.reviewedDigest = e.reviewDigest;
  else e.reason = decision.reason;
  await save(c, active);
  return {
    action:
      e.status === "coding"
        ? "code"
        : decision.action === "wait" || e.status === "blocked"
          ? "done"
          : "wait",
    lease,
    payload: JSON.stringify(e),
  };
}
export async function advance(lease: Lease): Promise<Action> {
  const c = extension.config,
    active = await current(c, lease),
    e = active.experiment,
    git = new GitHub(c),
    platform = new Vercel(c);
  if (e.status === "rolled-back") {
    let revert;
    try {
      revert = await createRevert(c, e);
    } catch {
      e.reason =
        "Production remains rolled back. Signed revert publication is blocked or unconfirmed; reconcile its deterministic branch, main source and private Sandbox logs before another release.";
      await save(c, active);
      return {
        action: "done",
        lease,
        report: reportFor(e, "revert-blocked", e.release?.rollback?.checks),
      };
    }
    e.release!.rollback!.revertedBy = revert;
    await save(c, active);
    await store(c).put("release:last", e);
    const next: Experiment = {
      id: `revert-${e.id}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rootSession: e.rootSession,
      status: "review",
      base: revert.base,
      finding: {
        ...e.finding,
        id: `revert-${e.finding.id}`,
        metric: "failure",
        target: "release",
        summary: "Reconcile main with the verified rollback",
      },
      attempts: 0,
      candidate: revert,
      checks: [],
    };
    active.experiment = next;
    await save(c, active);
    return { action: "wait", lease };
  }
  if (terminal.has(e.status))
    return { action: "done", lease, report: reportFor(e, e.status, e.checks) };
  if (e.status === "monitoring" || (e.status === "blocked" && e.release?.deployment)) {
    active.experiment = await monitorRelease(c, e);
    await save(c, active);
    await store(c).put("release:last", active.experiment);
    return {
      action: active.experiment.status === "rolled-back" ? "wait" : "done",
      lease,
      report: reportFor(
        active.experiment,
        active.experiment.status,
        active.experiment.release?.checks,
      ),
    };
  }
  if (e.status === "deploying" || e.status === "merging") {
    if (!e.release) throw new Error("Release baseline missing; stop instead of deploying");
    const pr = await git.api(`/repos/${git.repo}/pulls/${e.candidate!.pr}`);
    if (pr.merged && /^[a-f0-9]{40}$/.test(pr.merge_commit_sha ?? "")) {
      const commit = await git.api(`/repos/${git.repo}/commits/${pr.merge_commit_sha}`);
      if (pr.head?.sha !== e.candidate!.head || commit.commit?.verification?.verified !== true)
        throw new Error("Uncertain merge does not match the verified candidate/signature");
      e.release.sha = pr.merge_commit_sha;
    } else if (e.status === "merging") {
      if (c.policy.mode !== "ship") {
        e.reason = "Release paused: current policy permits proposals, not new merges";
        await save(c, active);
        return { action: "done", lease };
      }
      const inspection = await inspectCandidate(c, e.candidate!, git);
      const fingerprint = reviewFingerprint(e.candidate!, inspection);
      if (e.reviewedDigest !== fingerprint) {
        e.status = "review";
        e.reviewDigest = fingerprint;
        e.feedback = inspection.feedback;
        await save(c, active);
        return { action: "review", lease, payload: reviewPayload(e.candidate!, inspection) };
      }
      e.release.sha = await mergeExact(c, e.candidate!, e.reviewedDigest!, git);
    }
    if ((await git.main()) !== e.release.sha) {
      e.status = "blocked";
      e.reason = "Target branch changed after merge; reconcile before deployment";
      await save(c, active);
      return { action: "done", lease };
    }
    e.status = "deploying";
    await save(c, active);
    let deployed = await platform.deployment(c.project.productionUrl);
    if (deployed.sha !== e.release.sha) {
      if (c.policy.mode !== "ship") {
        e.reason = "Release paused: current policy permits proposals, not new deployments";
        await save(c, active);
        return { action: "done", lease };
      }
      if (deployed.id !== e.release.baseline.id)
        throw new Error("Production moved during release; do not overwrite another deployment");
      if (e.release.deployStartedAt) {
        const attempts = await platform.deploymentAttempts(e.release.sha);
        if (
          attempts.some((attempt) => !["ERROR", "CANCELED"].includes(attempt.state)) ||
          Date.now() - e.release.deployStartedAt < 1_200_000
        ) {
          e.reason = "Reconciled a pending/unconfirmed deployment; waiting without duplicating it";
          await save(c, active);
          return { action: "wait", lease };
        }
      }
      if ((e.release.deployAttempts ?? 0) >= c.policy.maxAttempts) {
        e.status = "blocked";
        e.reason =
          "Bounded deployment attempts exhausted after reconciliation; inspect publisher/setup logs";
        await save(c, active);
        return { action: "done", lease };
      }
      e.release.deployStartedAt = Date.now();
      e.release.deployAttempts = (e.release.deployAttempts ?? 0) + 1;
      await save(c, active);
      await createHostedRunner(c).deploy(e.release.sha);
      deployed = await platform.deployment(c.project.productionUrl, e.release.sha, "production");
    }
    e.release.deployment = deployed;
    e.status = "monitoring";
    await save(c, active);
    active.experiment = await monitorRelease(c, e);
    await save(c, active);
    await store(c).put("release:last", active.experiment);
    return {
      action: active.experiment.status === "rolled-back" ? "wait" : "done",
      lease,
      report: reportFor(
        active.experiment,
        active.experiment.status,
        active.experiment.release?.checks,
      ),
    };
  }
  if (!e.candidate) return { action: "done", lease, report: reportFor(e, e.status) };
  const candidate = e.candidate;
  if (e.baseUpdate) {
    const intent = e.baseUpdate;
    if ((await reconcileBaseUpdate(candidate, intent, git)) === "waiting") {
      if (Date.now() - intent.startedAt >= 1_200_000) {
        if (intent.attempts >= c.policy.maxAttempts) {
          e.status = "blocked";
          e.reason =
            "Base-branch update remains unconfirmed after bounded reconciliation; preserve PR/head and inspect GitHub";
          await save(c, active);
          return { action: "done", lease };
        }
        intent.startedAt = Date.now();
        intent.attempts++;
        await save(c, active);
        await git.api(`/repos/${git.repo}/pulls/${candidate.pr}/update-branch`, "PUT", {
          expected_head_sha: intent.expectedHead,
        });
      }
      return { action: "wait", lease };
    }
    e.base = candidate.base;
    e.baseUpdate = undefined;
    e.checks = [];
    e.verifiedHead = undefined;
    e.previewHead = undefined;
    e.reviewedDigest = undefined;
    await save(c, active);
  }
  const inspection = await inspectCandidate(c, candidate, git);
  e.feedback = inspection.feedback;
  if (inspection.pr.state === "closed" && !inspection.pr.merged) {
    e.status = "rejected";
    e.reason = "Candidate PR was closed; this finding/source pair will not be repeated";
    await save(c, active);
    return { action: "done", lease };
  }
  if (inspection.pr.merged) {
    e.status = "blocked";
    e.reason =
      "PR was merged outside this release transaction; verify production and capture a fresh baseline before releasing";
    await save(c, active);
    return { action: "done", lease };
  }
  if (e.verifiedHead !== candidate.head) {
    e.checks = await createHostedRunner(c).verify(candidate);
    if (allPassed(e.checks)) e.verifiedHead = candidate.head;
  }
  if (e.verifiedHead === candidate.head && e.previewHead !== candidate.head) {
    const checks = await verifyChange(c, candidate, platform);
    e.checks = [
      ...e.checks.filter(
        (check) =>
          ![
            "exact preview",
            "fresh authenticated tool",
            "change-specific regression",
            "measured improvement",
          ].includes(check.name),
      ),
      ...checks,
    ];
    if (allPassed(checks)) e.previewHead = candidate.head;
  }
  if (e.verifiedHead === candidate.head && e.previewHead === candidate.head) {
    for (const id of candidate.addressedThreads)
      if (inspection.feedback.threads.some((thread) => thread.id === id && !thread.resolved))
        await git.resolveThread(id);
    await markReady(git, inspection.pr);
  }
  e.checks = [
    ...new Map([...e.checks, ...inspection.checks].map((check) => [check.name, check])).values(),
  ];
  e.reviewDigest = reviewFingerprint(candidate, inspection);
  const evidence = reviewPayload(candidate, inspection, e.checks);
  if (e.reviewedDigest !== e.reviewDigest) {
    await save(c, active);
    return { action: "review", lease, payload: evidence };
  }
  const main = await git.main();
  if (main !== candidate.base && e.verifiedHead === candidate.head) {
    e.baseUpdate = { expectedHead: candidate.head, base: main, startedAt: Date.now(), attempts: 1 };
    await save(c, active);
    await git.api(`/repos/${git.repo}/pulls/${candidate.pr}/update-branch`, "PUT", {
      expected_head_sha: candidate.head,
    });
    return { action: "wait", lease };
  }
  const ready =
    e.verifiedHead === candidate.head &&
    e.previewHead === candidate.head &&
    allPassed(inspection.checks) &&
    e.reviewedDigest === e.reviewDigest;
  if (!ready) {
    e.status = "review";
    e.reason = "Awaiting exact-head checks, review resolution or missing executable evidence";
    await save(c, active);
    return {
      action: e.checks.some((check) => check.status === "failed" || check.status === "unavailable")
        ? "done"
        : "wait",
      lease,
    };
  }
  e.status = "ready";
  if (c.policy.mode !== "ship") {
    e.reason = "Verified proposal ready; this installation is configured for proposals";
    await save(c, active);
    return { action: "done", lease };
  }
  const baseline = await platform.deployment(c.project.productionUrl);
  const baselineProof = await verifyRelease(c, baseline);
  if (!allPassed(baselineProof.checks)) {
    e.reason = "Known-good production baseline could not be verified; release remains blocked";
    await save(c, active);
    return { action: "done", lease };
  }
  e.release = { sha: "", baseline, baselineChecks: baselineProof.checks };
  e.status = "merging";
  await save(c, active);
  return { action: "wait", lease };
}
function reviewPayload(
  candidate: NonNullable<Experiment["candidate"]>,
  inspection: Awaited<ReturnType<typeof inspectCandidate>>,
  checks: Check[] = [],
): string {
  const payload = JSON.stringify({
    kind: "review",
    candidate,
    checks: [...checks, ...inspection.checks],
    feedback: boundFeedback(inspection.feedback),
    outputs: inspection.outputs,
  });
  if (Buffer.byteLength(payload) > 200_000)
    throw new Error(
      "Review evidence exceeds bounded model context; inspect and reduce outside the candidate before shipping",
    );
  return payload;
}
export async function finish(lease: Lease | undefined, supplied?: Report): Promise<Report> {
  const c = extension.config,
    db = store(c);
  const active = lease ? await db.active() : null;
  const report =
    supplied ??
    reportFor(
      active?.experiment ?? null,
      active?.experiment?.status ?? "no-change",
      active?.experiment?.checks,
    );
  if (report.status === "already-running") return report;
  await db.put(`analysis:${report.date}`, report);
  if (lease) await db.release(lease);
  if (c.report) {
    try {
      const receipt = await c.report(report);
      if (!receiptValid(receipt, report.id)) throw new Error("Unconfirmed receipt");
      await db.put(`report:${report.id}`, { id: report.id, receipt });
    } catch {
      report.checks.push({
        name: "daily delivery",
        status: "unavailable",
        reason:
          "Delivery unconfirmed; reconcile the same report ID through the configured bot before retrying",
      });
      await db.put(`analysis:${report.date}`, report);
    }
  }
  return report;
}
export async function fail(lease: Lease | undefined): Promise<Report> {
  const c = extension.config,
    db = store(c),
    active = lease ? await db.active() : null;
  if (
    active?.experiment &&
    lease &&
    active.lease.owner === lease.owner &&
    active.lease.fence === lease.fence
  ) {
    active.experiment.reason =
      "Run interrupted or provider operation failed; preserve branch/head, publishing intent, checks and baseline. Reconcile before retry.";
    await save(c, active);
  }
  return reportFor(active?.experiment ?? null, "interrupted", [
    {
      name: "maintenance run",
      status: "failed",
      reason:
        "Inspect private Workflow, Sandbox, review/setup and provider logs; stored state identifies the next action",
    },
  ]);
}
