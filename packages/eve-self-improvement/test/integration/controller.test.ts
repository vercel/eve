import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { config, experiment, candidate, evidence, BASE, HEAD, MERGED } from "./fixtures.js";
import type { Active, Experiment, ReviewFeedback } from "../../extension/lib/types.js";

const c = config();
let metadata = evidence();
let feedback: ReviewFeedback = {
  comments: [],
  reviews: [],
  threads: [],
};
let writes: string[] = [];
let active: Active;
const records = new Map<string, unknown>();
let monitored: string[] = [];
let monitorStatus: Experiment["status"] = "shipped";
let failJournal = false;
let prState: Record<string, unknown> = { state: "open", draft: false };
let inspectionChecks: Experiment["checks"] = [];
let sandboxChecks: Experiment["checks"] = [];
let previewChecks: Experiment["checks"] = [];
let verified: string[] = [];
let verifiedBaselines: string[] = [];
let releasedLeases = 0;
let mergeError: Error | undefined;
const db = {
  async active() {
    return structuredClone(active);
  },
  async renew() {},
  async list() {
    return [];
  },
  async observations() {
    return { complete: false, values: [] };
  },
  async acquire() {
    return structuredClone(active);
  },
  async purge() {},
  async get(key: string) {
    return structuredClone(records.get(key) ?? null);
  },
  async put(key: string, value: unknown) {
    if (key === "release:last" && failJournal) throw new Error("Journal unavailable");
    records.set(key, structuredClone(value));
  },
  async save(_lease: unknown, value: Experiment | null) {
    active.experiment = structuredClone(value);
  },
  async release() {
    releasedLeases++;
  },
};
mock.module("../../extension/extension.js", { exports: { default: { config: c } } });
mock.module("../../extension/lib/store.js", { exports: { store: () => db } });
mock.module("../../extension/lib/monitor.js", {
  exports: {
    monitorRelease: async (_config: unknown, e: Experiment) => {
      monitored.push(e.id);
      e.status = monitorStatus;
      return e;
    },
  },
});
const { GitHub, Vercel } = await import("../../extension/lib/providers.js");
mock.method(GitHub.prototype, "api", async () => ({ id: 1, full_name: "fixture/agent" }));
mock.method(GitHub.prototype, "feedback", async () => structuredClone(feedback));
mock.method(Vercel.prototype, "api", async () => ({
  id: "prj_fixture",
  accountId: "team_fixture",
  link: { repoId: 1 },
}));
const review = await import("../../extension/lib/review.js");
mock.module("../../extension/lib/review.js", {
  exports: {
    ...review,
    inspectCandidate: async () => ({
      checks: inspectionChecks,
      outputs: [],
      feedback,
      pr: prState,
    }),
    reviewFingerprint: () => "reviewed",
    mergeExact: async () => {
      if (mergeError) throw mergeError;
      writes.push("merge");
      return MERGED;
    },
  },
});
mock.module("../../extension/lib/agent-runs.js", {
  exports: { readAgentRuns: async () => structuredClone(metadata) },
});
const hosted = await import("../../extension/lib/hosted.js");
mock.module("../../extension/lib/hosted.js", {
  exports: {
    ...hosted,
    createHostedRunner: () => ({
      verify: async (proposal: { head: string }) => {
        verified.push(proposal.head);
        return structuredClone(sandboxChecks);
      },
      deploy: async () => {
        writes.push("deploy");
      },
    }),
  },
});
const verification = await import("../../extension/lib/verify.js");
mock.module("../../extension/lib/verify.js", {
  exports: {
    ...verification,
    verifyChange: async () => structuredClone(previewChecks),
    verifyRelease: async (_config: unknown, deployment: { id: string }) => {
      verifiedBaselines.push(deployment.id);
      return { checks: [{ name: "baseline", status: "passed", reason: "Healthy fixture" }] };
    },
  },
});
const { prepare, advance, acceptReview } = await import("../../extension/lib/controller.js");
const ctx = {
  toolName: "self-improvement__cycle",
  callId: "call",
  session: {
    id: "scheduled",
    auth: { current: { authenticator: "app", principalId: "eve:app", principalType: "runtime" } },
    schedule: { definition: "self-improvement__daily" },
  },
} as Parameters<typeof prepare>[0];
const released = (): Experiment => ({
  ...experiment(),
  id: "released",
  status: "shipped",
  release: {
    sha: MERGED,
    baseline: {
      id: "baseline",
      sha: BASE,
      url: "https://baseline.example.com",
      teamId: "team_fixture",
      projectId: "prj_fixture",
      environment: "production",
      ready: true,
    },
    baselineChecks: [],
    deployment: {
      id: "released",
      sha: MERGED,
      url: "https://released.example.com",
      teamId: "team_fixture",
      projectId: "prj_fixture",
      environment: "production",
      ready: true,
    },
  },
});
function reset(e: Experiment) {
  records.clear();
  feedback = { comments: [], reviews: [], threads: [] };
  writes = [];
  metadata = evidence();
  monitored = [];
  monitorStatus = "shipped";
  failJournal = false;
  prState = { state: "open", draft: false };
  inspectionChecks = [];
  sandboxChecks = [];
  previewChecks = [];
  verified = [];
  verifiedBaselines = [];
  releasedLeases = 0;
  mergeError = undefined;
  c.policy.mode = "propose";
  active = { lease: { owner: "owner", fence: 1, until: Date.now() + 60_000 }, experiment: e };
}
test("scheduled analysis and PR review still monitor the last production release", async () => {
  for (const status of ["analyzing", "review"] as const) {
    reset({ ...experiment(), id: "pending", status, candidate: candidate() });
    records.set("release:last", released());
    const result = await prepare(ctx);
    assert.deepEqual(monitored, ["released"]);
    assert.equal(active.experiment!.id, "pending");
    assert.equal(result.action, status === "analyzing" ? "analyze" : "wait");
  }
});
test("release recovery pauses and later resumes a pending experiment", async () => {
  for (const status of ["blocked", "rolled-back"] as const) {
    reset({ ...experiment(), id: "pending", status: "review", candidate: candidate() });
    records.set("release:last", released());
    monitorStatus = status;
    await prepare(ctx);
    assert.equal(active.experiment!.id, "released");
    assert.equal(active.experiment!.status, status);
    assert.equal((records.get("resume:experiment") as Experiment).id, "pending");
  }
  active.experiment = { ...experiment(), id: "revert", status: "rejected" };
  records.set("release:last", null);
  assert.equal((await prepare(ctx)).report!.status, "recovery-blocked");
  assert.equal((records.get("resume:experiment") as Experiment).id, "pending");
  active.experiment = { ...released(), id: "revert" };
  monitorStatus = "shipped";
  records.set("release:last", null);
  await prepare(ctx);
  assert.equal(active.experiment!.id, "pending");
  assert.equal(records.get("resume:experiment"), null);
});
test("a failed release journal write is retried before discarding shipped recovery state", async () => {
  reset(released());
  failJournal = true;
  assert.equal((await prepare(ctx)).report!.status, "setup-blocked");
  assert.equal(active.experiment!.status, "shipped");
  assert.equal(monitored.length, 0);
  failJournal = false;
  records.set(`analysis:${new Date().toISOString().slice(0, 10)}`, { status: "no-findings" });
  await prepare(ctx);
  assert.equal((records.get("release:last") as Experiment).id, "released");
  assert.deepEqual(monitored, ["released"]);
});

test("proposal mode blocks new writes while resuming merge and deployment intents", async (t) => {
  for (const status of ["merging", "deploying"] as const) {
    const e = { ...released(), status, candidate: candidate(), reviewedDigest: "reviewed" };
    reset(e);
    c.release = {
      deploy: async () => {
        writes.push("deploy");
      },
    };
    const api = t.mock.method(GitHub.prototype, "api", async (path: string) =>
      path.includes("/commits/")
        ? { commit: { verification: { verified: true } } }
        : {
            merged: status === "deploying",
            merge_commit_sha: MERGED,
            head: { sha: candidate().head },
          },
    );
    const main = t.mock.method(GitHub.prototype, "main", async () => MERGED);
    const production = t.mock.method(Vercel.prototype, "deployment", async () =>
      writes.includes("deploy") ? e.release!.deployment! : e.release!.baseline,
    );
    assert.equal((await advance(active.lease)).action, "done");
    assert.deepEqual(writes, []);
    assert.equal(active.experiment!.status, status);
    api.mock.restore();
    main.mock.restore();
    production.mock.restore();
  }
});
test("truncated local observations do not suppress complete independent run failures", async (t) => {
  reset(experiment());
  active.experiment = null;
  metadata = {
    ...evidence(),
    runs: [0, 1].map((i) => ({ id: `run-${i}`, status: "failed", scheduled: false, createdAt: 1 })),
  };
  t.mock.method(GitHub.prototype, "main", async () => BASE);
  const result = await prepare(ctx);
  assert.equal(result.action, "analyze");
  assert.equal(active.experiment!.finding.metric, "failure");
  assert.equal(active.experiment!.finding.samples, 2);
});
test("oversized review text stays classifiable and bounded across scheduled resumes", async () => {
  reset({
    ...experiment(),
    status: "review",
    candidate: candidate(),
    verifiedHead: candidate().head,
    previewHead: candidate().head,
  });
  feedback.comments = Array.from({ length: 60 }, (_, i) => ({
    id: String(i),
    url: `https://github.com/fixture/comment/${i}`,
    body: "大量のコメント".repeat(10000),
  }));
  feedback.reviews = feedback.comments.map((comment, i) => ({
    id: `review-${i}`,
    state: i === 0 ? "CHANGES_REQUESTED" : "COMMENTED",
    body: comment.body,
    submittedAt: "2026-11-12T00:00:00Z",
  }));
  feedback.threads = feedback.comments.map((comment, i) => ({
    id: `thread-${i}`,
    resolved: i !== 0,
    outdated: i % 2 === 0,
    body: comment.body,
  }));
  const result = await advance(active.lease);
  assert.equal(result.action, "review");
  assert.ok(Buffer.byteLength(result.payload!) < 200_000);
  const display = JSON.parse(result.payload!).feedback;
  assert.ok(display.omittedComments >= 10);
  assert.ok(Buffer.byteLength(JSON.stringify(display.comments)) < 20_002);
  assert.equal(display.comments.at(-1).id, "59");
  assert.ok(display.commentsDigest);
  for (const key of ["reviews", "threads"] as const) {
    assert.ok(Buffer.byteLength(JSON.stringify(display[key])) < 30_000);
    assert.deepEqual(
      display[key].map(({ body: _body, ...metadata }: { body: string }) => metadata),
      feedback[key].map(({ body: _body, ...metadata }) => metadata),
    );
    assert.ok(display[`${key}Digest`]);
  }
  const resumed = await prepare(ctx);
  assert.ok(Buffer.byteLength(resumed.payload!) < 100_000);
  for (const key of ["commentsDigest", "reviewsDigest", "threadsDigest"])
    assert.equal(JSON.parse(resumed.payload!).feedback[key], display[key]);
  feedback.comments[0].body += " edited";
  feedback.reviews[0].body += " edited";
  feedback.threads[0].body += " edited";
  const edited = await advance(active.lease);
  for (const key of ["commentsDigest", "reviewsDigest", "threadsDigest"])
    assert.notEqual(JSON.parse(edited.payload!).feedback[key], display[key]);
});
test("private status requires an owner-exclusive direct conversation", async () => {
  reset(experiment());
  const status = (await import("../../extension/tools/status.js")).default;
  const owner = {
    authenticator: "basic",
    principalId: "owner",
    principalType: "user",
    attributes: {},
  };
  const context = (space: unknown) =>
    ({ session: { auth: { current: owner, initiator: owner } }, conversation: { space } }) as never;
  for (const space of [
    undefined,
    { type: "shared", visibility: "private" },
    { type: "shared", visibility: "public" },
    { type: "direct" },
  ]) {
    await assert.rejects(async () => {
      await status.execute!({}, context(space));
    }, /private direct/);
  }
  const result = await status.execute!({}, context({ type: "direct", visibility: "private" }));
  assert.ok(result && "active" in result);
  assert.equal(result.active!.id, "fixture");
});
test("a rejected recovery PR blocks new work even without a paused experiment", async (t) => {
  t.mock.method(GitHub.prototype, "main", async () => BASE);
  reset({ ...experiment(), id: "revert-fixture", status: "rejected", candidate: candidate() });
  const result = await prepare(ctx);
  assert.equal(result.report!.status, "recovery-blocked");
  assert.equal(active.experiment!.id, "revert-fixture");
  assert.equal(active.experiment!.status, "blocked");
});

test("an externally merged verified proposal completes without blocking later cycles", async (t) => {
  reset({ ...experiment(), status: "ready", candidate: candidate(), verifiedHead: HEAD });
  prState = { state: "closed", merged: true, head: { sha: HEAD }, merge_commit_sha: MERGED };
  t.mock.method(GitHub.prototype, "api", async (path: string) =>
    path.includes("/commits/")
      ? { commit: { verification: { verified: true } } }
      : { id: 1, full_name: "fixture/agent" },
  );
  assert.equal((await advance(active.lease)).action, "done");
  assert.equal(active.experiment!.status, "merged");
  records.set(`analysis:${new Date().toISOString().slice(0, 10)}`, { status: "no-findings" });
  await prepare(ctx);
  assert.equal(active.experiment, null);
  assert.deepEqual(writes, []);
});
test("an externally merged unverified head remains blocked", async () => {
  reset({ ...experiment(), status: "review", candidate: candidate(), verifiedHead: HEAD });
  prState = { state: "closed", merged: true, head: { sha: BASE }, merge_commit_sha: MERGED };
  await advance(active.lease);
  assert.equal(active.experiment!.status, "blocked");
});
test("a moving base exits merging so normal review can update and reverify the candidate", async (t) => {
  reset({ ...released(), status: "merging", candidate: candidate(), reviewedDigest: "reviewed" });
  c.policy.mode = "ship";
  t.mock.method(GitHub.prototype, "api", async () => ({ merged: false }));
  t.mock.method(GitHub.prototype, "main", async () => MERGED);
  t.mock.method(Vercel.prototype, "deployment", async () => released().release!.baseline);
  inspectionChecks = [{ name: "up-to-date branch", status: "pending", reason: "Main moved" }];
  assert.equal((await advance(active.lease)).action, "wait");
  assert.equal(active.experiment!.status, "review");
  assert.equal(active.experiment!.release, undefined);
  assert.deepEqual(writes, []);
});
test("production already serving the verified release is adopted even when main advanced", async (t) => {
  reset({ ...released(), status: "deploying", candidate: candidate() });
  t.mock.method(GitHub.prototype, "api", async (path: string) =>
    path.includes("/commits/")
      ? { commit: { verification: { verified: true } } }
      : { merged: true, merge_commit_sha: MERGED, head: { sha: HEAD } },
  );
  t.mock.method(GitHub.prototype, "main", async () => "d".repeat(40));
  t.mock.method(Vercel.prototype, "deployment", async () => released().release!.deployment!);
  await advance(active.lease);
  assert.equal(active.experiment!.status, "shipped");
  assert.deepEqual(monitored, ["released"]);
  assert.deepEqual(writes, []);
});
test("ready but unaliased deployment attempts stop waiting after the reconciliation deadline", async (t) => {
  const e = { ...released(), status: "deploying" as const, candidate: candidate() };
  e.release!.deployment = undefined;
  e.release!.deployStartedAt = Date.now() - 1_200_001;
  e.release!.deployAttempts = c.policy.maxAttempts;
  reset(e);
  c.policy.mode = "ship";
  t.mock.method(GitHub.prototype, "api", async (path: string) =>
    path.includes("/commits/")
      ? { commit: { verification: { verified: true } } }
      : { merged: true, merge_commit_sha: MERGED, head: { sha: HEAD } },
  );
  t.mock.method(GitHub.prototype, "main", async () => MERGED);
  t.mock.method(Vercel.prototype, "deployment", async () => e.release!.baseline);
  t.mock.method(Vercel.prototype, "deploymentAttempts", async () => [
    { id: "attempt", state: "READY" },
  ]);
  assert.equal((await advance(active.lease)).action, "done");
  assert.equal(active.experiment!.status, "blocked");
  assert.deepEqual(writes, []);
});
test("failed sandbox verification is recorded once per immutable candidate head", async (t) => {
  reset({ ...experiment(), status: "review", candidate: candidate(), reviewedDigest: "reviewed" });
  t.mock.method(GitHub.prototype, "main", async () => BASE);
  sandboxChecks = [{ name: "candidate tests", status: "failed", reason: "Regression fails" }];
  await advance(active.lease);
  await advance(active.lease);
  assert.deepEqual(verified, [HEAD]);
  active.experiment!.candidate!.head = MERGED;
  await advance(active.lease);
  assert.deepEqual(verified, [HEAD, MERGED]);
});
test("quiet completed scheduled cycles settle readiness and release their lease", async (t) => {
  reset(experiment());
  t.mock.method(GitHub.prototype, "main", async () => BASE);
  active.experiment = null;
  const cycle = (await import("../../extension/tools/cycle.js")).default;
  await cycle.execute!({}, ctx as never);
  const occurrence = records.get("occurrence:last") as {
    settled: boolean;
    outcome: string;
    status: string;
  };
  assert.equal(occurrence.settled, true);
  assert.equal(occurrence.outcome, "completed");
  assert.equal(occurrence.status, "insufficient-evidence");
  assert.equal(releasedLeases, 1);
});
test("recovery-blocked cycles release their acquired lease", async () => {
  reset({ ...experiment(), id: "revert-fixture", status: "rejected" });
  const cycle = (await import("../../extension/tools/cycle.js")).default;
  await cycle.execute!({}, ctx as never);
  assert.equal(releasedLeases, 1);
});
test("only verified feedback threads owned by the publishing bot are auto-resolved", async (t) => {
  reset({
    ...experiment(),
    status: "review",
    candidate: {
      ...candidate(),
      addressedThreads: ["own-bot", "human", "other-bot", "unknown"],
    },
    verifiedHead: HEAD,
    previewHead: HEAD,
  });
  feedback.threads = ["own-bot", "human", "other-bot", "unknown"].map((id) => ({
    id,
    resolved: false,
    outdated: false,
    body: "Review finding",
    canAutoResolve: id === "unknown" ? undefined : id === "own-bot",
  }));
  const resolved: string[] = [];
  t.mock.method(GitHub.prototype, "resolveThread", async (id: string) => {
    resolved.push(id);
  });
  await advance(active.lease);
  assert.deepEqual(resolved, ["own-bot"]);
});
test("a changed production baseline is reverified before merging and used for recovery", async (t) => {
  const e = {
    ...released(),
    status: "merging" as const,
    candidate: candidate(),
    reviewedDigest: "reviewed",
  };
  e.release!.deployment = undefined;
  reset(e);
  c.policy.mode = "ship";
  inspectionChecks = [{ name: "required check", status: "passed", reason: "Verified fixture" }];
  t.mock.method(GitHub.prototype, "api", async () => ({ merged: false }));
  t.mock.method(GitHub.prototype, "main", async () => (writes.includes("merge") ? MERGED : BASE));
  const baseline = { ...e.release!.baseline, id: "new-baseline" };
  t.mock.method(Vercel.prototype, "deployment", async () =>
    writes.includes("deploy") ? released().release!.deployment! : baseline,
  );
  await advance(active.lease);
  assert.equal(active.experiment!.release!.baseline.id, "new-baseline");
  assert.deepEqual(verifiedBaselines, ["new-baseline"]);
  assert.deepEqual(writes, ["merge", "deploy"]);
});
test("pending GitHub merge policy returns to review without discarding the candidate", async (t) => {
  const e = {
    ...released(),
    status: "merging" as const,
    candidate: candidate(),
    reviewedDigest: "reviewed",
  };
  e.release!.deployment = undefined;
  reset(e);
  c.policy.mode = "ship";
  mergeError = new review.MergePolicyBlocked("GitHub mergeability is UNKNOWN");
  inspectionChecks = [{ name: "required check", status: "passed", reason: "Verified fixture" }];
  t.mock.method(GitHub.prototype, "api", async () => ({ merged: false }));
  t.mock.method(GitHub.prototype, "main", async () => BASE);
  t.mock.method(Vercel.prototype, "deployment", async () => e.release!.baseline);
  assert.equal((await advance(active.lease)).action, "wait");
  assert.equal(active.experiment!.status, "review");
  assert.equal(active.experiment!.candidate!.head, HEAD);
  assert.equal(active.experiment!.release, undefined);
  assert.deepEqual(writes, []);
});

test("a newer production release completes superseded deployment reconciliation in proposal mode", async (t) => {
  const e = { ...released(), status: "deploying" as const, candidate: candidate() };
  e.release!.deployment = undefined;
  reset(e);
  t.mock.method(GitHub.prototype, "api", async (path: string) =>
    path.includes("/commits/")
      ? { commit: { verification: { verified: true } } }
      : { merged: true, merge_commit_sha: MERGED, head: { sha: HEAD } },
  );
  t.mock.method(GitHub.prototype, "main", async () => "d".repeat(40));
  t.mock.method(Vercel.prototype, "deployment", async () => ({
    ...released().release!.deployment!,
    id: "newer",
    sha: "d".repeat(40),
  }));
  await advance(active.lease);
  assert.equal(active.experiment!.status, "superseded");
  assert.deepEqual(writes, []);
});

test("analyst acceptance requires all fetched feedback to fit the classified evidence", async () => {
  const { boundFeedback } = await import("../../extension/lib/providers.js");
  const complete = {
    comments: [
      { id: "warning", body: "A complete warning", url: "https://github.com/fixture/comment" },
    ],
    reviews: [],
    threads: [],
  };
  const flooded = {
    ...complete,
    comments: Array.from({ length: 60 }, (_, i) => ({
      id: String(i),
      body: i === 0 ? "Early security warning" : "Routine message",
      url: `https://github.com/fixture/comment/${i}`,
    })),
  };
  const shortened = {
    ...complete,
    reviews: [
      {
        id: "review",
        body: "Review warning".repeat(1000),
        state: "COMMENTED",
        submittedAt: "2026-11-20T00:00:00Z",
      },
    ],
  };
  const legacy = boundFeedback(shortened);
  delete legacy.truncated;
  for (const raw of [flooded, shortened, legacy, complete]) {
    const bounded = boundFeedback(raw);
    reset({
      ...experiment(),
      status: "review",
      candidate: candidate(),
      reviewDigest: "observed",
      feedback: bounded,
    });
    await acceptReview(
      active.lease,
      JSON.stringify({ action: "accept", reason: "Reviewed the displayed evidence" }),
    );
    assert.equal(active.experiment!.reviewedDigest, raw === complete ? "observed" : undefined);
    if (raw !== complete) assert.match(active.experiment!.reason!, /omitted|truncated/i);
  }
});
test("incomplete feedback cannot start a new deployment while resuming a merged release", async (t) => {
  const e = { ...released(), status: "deploying" as const, candidate: candidate() };
  e.release!.deployment = undefined;
  reset(e);
  c.policy.mode = "ship";
  feedback.comments = [
    {
      id: "long-warning",
      body: "Do not ship. ".repeat(1000),
      url: "https://github.com/fixture/comment",
    },
  ];
  t.mock.method(GitHub.prototype, "api", async (path: string) =>
    path.includes("/commits/")
      ? { commit: { verification: { verified: true } } }
      : { merged: true, merge_commit_sha: MERGED, head: { sha: HEAD } },
  );
  t.mock.method(GitHub.prototype, "main", async () => MERGED);
  t.mock.method(Vercel.prototype, "deployment", async () => e.release!.baseline);
  assert.equal((await advance(active.lease)).action, "done");
  assert.deepEqual(writes, []);
  assert.equal(active.experiment!.release!.deployStartedAt, undefined);
  assert.match(active.experiment!.reason!, /omitted|truncated/i);
});
