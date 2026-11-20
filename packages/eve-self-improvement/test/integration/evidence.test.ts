import { test } from "node:test";
import assert from "node:assert/strict";
import { rankFindings, summarizeUsage } from "../../extension/lib/analyze.js";
import { compareMetrics } from "../../extension/lib/gates.js";
import { readAgentRuns, minimizeRun, sourceCursor } from "../../extension/lib/agent-runs.js";
import { configSchema, checkPath, namespace, owned } from "../../extension/lib/config.js";
import { pseudonym, fingerprint } from "../../extension/lib/observe.js";
import { authorizeCycle } from "../../extension/lib/controller.js";
import { config, cohort, observation, evidence, requestFixture } from "./fixtures.js";

test("quality gains can justify higher spend; savings alone cannot qualify", () => {
  assert.equal(
    compareMetrics(cohort(), cohort({ quality: 0.9, costPerSessionUsd: 0.05 }), "quality").status,
    "passed",
  );
  assert.equal(
    compareMetrics(cohort(), cohort({ costPerSessionUsd: 0.001 }), "costPerSessionUsd").status,
    "failed",
  );
  assert.equal(
    compareMetrics(cohort(), cohort({ quality: 0.79, p95LatencyMs: 700 }), "p95LatencyMs").status,
    "failed",
  );
  assert.equal(
    compareMetrics(cohort(), cohort({ quality: 0.9, p95LatencyMs: 1051 }), "quality").status,
    "failed",
  );
  assert.equal(
    compareMetrics(cohort(), cohort({ quality: 0.9, p95LatencyMs: 1050 }), "quality").status,
    "passed",
  );
});
test("missing samples and zero baselines never become passing population evidence", () => {
  assert.equal(
    compareMetrics(cohort({ sampleSize: 19 }), cohort({ quality: 0.9 }), "quality").status,
    "unavailable",
  );
  assert.equal(
    compareMetrics(cohort({ failureRate: 0 }), cohort({ failureRate: 0 }), "failureRate").status,
    "failed",
  );
});
test("correctness outranks latency; corrections count distinct turns and principals", () => {
  const calls = [0, 1, 2, 3, 4].map((i) => observation(i, { durationMs: 30000 }));
  const feedback = [0, 1, 2].map((i) =>
    observation(10 + i, {
      kind: "feedback",
      turn: `turn-${i}`,
      session: `session-${i}`,
      feedback: "correction",
      confidence: 0.9,
    }),
  );
  const result = rankFindings(
    evidence([...calls, ...feedback, { ...feedback[0], id: "duplicate-feedback" }]),
  );
  assert.equal(result[0].metric, "correction");
  assert.equal(result[0].count, 3);
  assert.ok(!result.some((f) => f.metric === "latency"));
  assert.ok(
    !rankFindings(
      evidence([...calls, ...feedback.map((f) => ({ ...f, principal: "one-person" }))]),
    ).some((f) => f.metric === "correction"),
  );
});
test("open/waiting sessions and session lifetime do not create latency/failure findings", () => {
  const raw = {
    id: "session",
    status: "waiting",
    createdAt: "2026-11-12T00:00:00Z",
    durationMs: 999999999,
    turns: 8,
    title: "PRIVATE",
    prompt: "PRIVATE",
    usage: { costUsd: 0.02 },
  };
  const run = minimizeRun(raw)!;
  const data = evidence();
  data.runs = [run, { ...run, id: "second" }];
  assert.deepEqual(rankFindings(data), []);
  assert.ok(!JSON.stringify(run).includes("PRIVATE"));
  assert.ok(!("durationMs" in run));
  assert.equal(summarizeUsage(data).reportedCostUsd, 0.04);
});
test("incomplete metadata cannot create a recommendation or fake missing pricing", () => {
  const data = evidence([
    observation(1, { outcome: "failed" }),
    observation(2, { outcome: "failed" }),
  ]);
  data.complete = false;
  assert.deepEqual(rankFindings(data), []);
  assert.equal(summarizeUsage(data).reportedCostUsd, null);
});
test("repeat fingerprints are scoped to a turn, not repeated work across sessions", () => {
  assert.ok(
    !rankFindings(evidence([0, 1, 2].map((i) => observation(i, { fingerprint: "same" })))).some(
      (f) => f.metric === "redundancy",
    ),
  );
  assert.ok(
    rankFindings(
      evidence(
        [0, 1, 2].map((i) => observation(i, { session: "one", turn: "one", fingerprint: "same" })),
      ),
    ).some((f) => f.metric === "redundancy"),
  );
});
test("merged Agent Runs pagination continues an empty page with a stable absolute window", async () => {
  const urls: URL[] = [];
  const fetcher = requestFixture((url) => {
    urls.push(url);
    return Response.json(
      urls.length === 1
        ? {
            runs: [],
            meta: { dataConfidence: "real" },
            pageInfo: {
              hasMore: true,
              nextOffsets: {
                otel: 100,
                workflow: 0,
                otelRange: { from: 100, to: 200 },
                otelCursor: "opaque_cursor",
              },
            },
          }
        : {
            runs: [{ id: "real", status: "waiting", createdAt: 150, title: "PRIVATE" }],
            meta: { dataConfidence: "real" },
            pageInfo: { hasMore: false },
          },
    );
  });
  const result = await readAgentRuns(config(), { from: 100, to: 200 }, fetcher);
  assert.equal(result.complete, true);
  assert.equal(result.runs.length, 1);
  assert.equal(urls[1].searchParams.get("cursor"), "2s.0.2s.5k.opaque_cursor");
  for (const url of urls) {
    assert.equal(url.searchParams.get("from"), "100");
    assert.equal(url.searchParams.get("to"), "200");
    assert.equal(url.searchParams.has("trace"), false);
    assert.equal(url.searchParams.has("page"), false);
  }
});
test("Agent Runs pagination binds current API cursors to the provider's clamped range", async () => {
  const urls: URL[] = [];
  const fetcher = requestFixture((url) => {
    urls.push(url);
    return Response.json(
      urls.length === 1
        ? {
            runs: [],
            meta: { dataConfidence: "real" },
            pageInfo: {
              hasMore: true,
              nextCursor: "opaque_cursor",
              nextOffsets: {
                otelRange: { from: 120000, to: 200000 },
                otelCursor: "opaque_cursor",
              },
            },
          }
        : {
            runs: [{ id: "next-page", status: "failed", createdAt: 150 }],
            meta: { dataConfidence: "real" },
            pageInfo: { hasMore: false },
          },
    );
  });
  const result = await readAgentRuns(config(), { from: 100, to: 200 }, fetcher);
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.runs.map((run) => run.id),
    ["next-page"],
  );
  assert.equal(urls[1].searchParams.get("cursor"), "2klc.4abk.opaque_cursor");
  assert.equal(urls[1].searchParams.get("from"), "100");
  assert.equal(urls[1].searchParams.get("to"), "200");
});
test("missing/repeated continuations, fake source confidence and provider errors remain unavailable", async () => {
  for (const value of [
    { runs: [], meta: { dataConfidence: "real" }, pageInfo: { hasMore: true } },
    { runs: [], meta: { dataConfidence: "synthetic" }, pageInfo: { hasMore: false } },
    {
      runs: [],
      meta: { dataConfidence: "real" },
      pageInfo: { hasMore: true, nextOffsets: { otelCursor: "unbound" } },
    },
    {
      runs: [],
      meta: { dataConfidence: "real" },
      pageInfo: {
        hasMore: true,
        nextOffsets: { otelRange: { from: 200, to: 100 }, otelCursor: "reversed" },
      },
    },
  ])
    assert.equal(
      (
        await readAgentRuns(
          config(),
          { from: 100, to: 200 },
          requestFixture(() => Response.json(value)),
        )
      ).complete,
      false,
    );
  const repeated = await readAgentRuns(
    config(),
    { from: 100, to: 200 },
    requestFixture(() =>
      Response.json({
        runs: [],
        meta: { dataConfidence: "real" },
        pageInfo: { hasMore: true, nextOffsets: { otel: 0, workflow: 0 } },
      }),
    ),
  );
  assert.ok(repeated.reasons.some((reason) => reason.includes("repeated")));
  const denied = await readAgentRuns(
    config(),
    { from: 100, to: 200 },
    requestFixture(() => new Response("PRIVATE CREDENTIAL", { status: 403 })),
  );
  assert.ok(!JSON.stringify(denied).includes("PRIVATE CREDENTIAL"));
  assert.equal(denied.complete, false);
  assert.equal(sourceCursor({ otel: 10001, workflow: 0 }), undefined);
  assert.equal(sourceCursor({ otel: 0, workflow: 0, otelCursor: "unbound" }), undefined);
});
test("only the exact real app schedule authorizes a root cycle", () => {
  const ctx: any = {
    toolName: "self-improvement__cycle",
    session: {
      id: "fixture",
      auth: { current: { authenticator: "app", principalType: "runtime", principalId: "eve:app" } },
      schedule: { definition: "self-improvement__daily" },
    },
  };
  assert.equal(authorizeCycle(ctx), "self-improvement__");
  assert.throws(() =>
    authorizeCycle({
      ...ctx,
      session: {
        ...ctx.session,
        auth: {
          current: {
            authenticator: "basic",
            principalType: "user",
            principalId: "eve:app",
            attributes: { schedule: true },
          },
        },
      },
    }),
  );
  assert.throws(() =>
    authorizeCycle({
      ...ctx,
      session: { ...ctx.session, schedule: { definition: "personal_task" } },
    }),
  );
  assert.throws(() =>
    authorizeCycle({ ...ctx, session: { ...ctx.session, parent: { rootSessionId: "other" } } }),
  );
});
test("owner and instance boundaries are explicit; risky paths and incomplete shipping configuration fail", () => {
  const c = config();
  assert.equal(owned(c, { authenticator: "basic", principalId: "owner" }), true);
  assert.equal(owned(c, { authenticator: "slack", principalId: "owner" }), false);
  assert.notEqual(namespace(c), namespace(config({ instance: "other" })));
  for (const path of [
    "../secret",
    "/secret",
    "agent/../../secret",
    ".env.local",
    ".git/config",
    ".github/workflows/ci.yml",
  ])
    assert.throws(() => checkPath(c, path));
  assert.doesNotThrow(() => checkPath(c, "agent/tools/search.ts"));
  assert.equal(
    configSchema.safeParse({ ...c, policy: { mode: "ship", requiredChecks: ["CI"] } }).success,
    false,
  );
});
test("HMAC pseudonyms are stable per key without raw identifiers/arguments", () => {
  const c = config(),
    other = config({
      privacy: { hmacSecret: () => "a-different-secret-with-at-least-32-characters" },
    });
  assert.equal(pseudonym(c, "user@example.com"), pseudonym(c, "user@example.com"));
  assert.notEqual(pseudonym(c, "user@example.com"), pseudonym(other, "user@example.com"));
  assert.ok(!fingerprint(c, { password: "fixture-private" }).includes("fixture-private"));
});
