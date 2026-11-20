import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { config, experiment, candidate, evidence, BASE, MERGED } from "./fixtures.js";
import type { Active, Experiment } from "../../extension/lib/types.js";

const c = config();
let metadata = evidence();
let feedback = {
  comments: [] as { id: string; body: string; url: string }[],
  reviews: [],
  threads: [],
};
let writes: string[] = [];
let active: Active;
const records = new Map<string, unknown>();
let monitored: string[] = [];
let monitorStatus: Experiment["status"] = "shipped";
let failJournal = false;
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
  async release() {},
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
      checks: [],
      outputs: [],
      feedback,
      pr: { state: "open", draft: false },
    }),
    reviewFingerprint: () => "reviewed",
    mergeExact: async () => {
      writes.push("merge");
      return MERGED;
    },
  },
});
mock.module("../../extension/lib/agent-runs.js", {
  exports: { readAgentRuns: async () => structuredClone(metadata) },
});
const { prepare, advance } = await import("../../extension/lib/controller.js");
const ctx = {
  toolName: "evolution__cycle",
  callId: "call",
  session: {
    id: "scheduled",
    auth: { current: { authenticator: "app", principalId: "eve:app", principalType: "runtime" } },
    schedule: { definition: "evolution__daily" },
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
  reset({ ...experiment(), id: "pending", status: "review", candidate: candidate() });
  records.set("release:last", released());
  monitorStatus = "blocked";
  await prepare(ctx);
  assert.equal(active.experiment!.id, "released");
  assert.equal((records.get("resume:experiment") as Experiment).id, "pending");
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
test("large ordinary comments have bounded review display without discarding candidate review", async () => {
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
  const result = await advance(active.lease);
  assert.equal(result.action, "review");
  assert.ok(Buffer.byteLength(result.payload!) < 200_000);
  const display = JSON.parse(result.payload!).feedback;
  assert.ok(display.omittedComments >= 10);
  assert.ok(Buffer.byteLength(JSON.stringify(display.comments)) < 20_002);
  assert.equal(display.comments.at(-1).id, "59");
  assert.ok(display.commentsDigest);
  const resumed = await prepare(ctx);
  assert.ok(Buffer.byteLength(resumed.payload!) < 50_000);
  assert.equal(JSON.parse(resumed.payload!).feedback.commentsDigest, display.commentsDigest);
  feedback.comments[0].body += " edited";
  const edited = await advance(active.lease);
  assert.notEqual(JSON.parse(edited.payload!).feedback.commentsDigest, display.commentsDigest);
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
