import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyOutcome } from "./gaps.mjs";
import { METRICS_VERSION, STANDARD_METRICS, deriveAttemptMetrics } from "./standard.mjs";

// Fixtures are trimmed `eve eval` detail artifacts captured from mock-model
// runs of e2e/fixtures/agent-tools and agent-subagents (mock models report
// no cost, so cost cases inject it below).
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const values = (metrics) =>
  Object.fromEntries(
    Object.entries(metrics).map(([key, m]) => [key, m.status === "measured" ? m.value : m.status]),
  );
const at = (ms) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
const event = (type, ms, data = {}) => ({
  type,
  meta: { id: `${type}@${ms}:${JSON.stringify(data)}`, at: at(ms) },
  data,
});

const synthetic = (events, extra = {}) => ({
  id: "synthetic",
  verdict: "passed",
  startedAt: at(0),
  completedAt: at(1000),
  result: {
    sessionId: "s",
    status: "completed",
    sessions: [{ sessionId: "s", primary: true, events }],
  },
  ...extra,
});
const turn = (start, end, inner, terminal = "turn.completed") => [
  event("turn.started", start, { turnId: "t" }),
  ...inner,
  event(terminal, end, { turnId: "t" }),
];
const compactedArtifact = () => {
  const artifact = synthetic([
    ...turn(0, 100, [
      event("step.started", 10, { turnId: "t", stepIndex: 0 }),
      event("step.completed", 90, {
        turnId: "t",
        stepIndex: 0,
        usage: { inputTokens: 10, outputTokens: 2 },
      }),
    ]),
    event("compaction.requested", 150, { turnId: "t", stepIndex: 1 }),
    event("compaction.completed", 200, { turnId: "t", stepIndex: 1 }),
  ]);
  artifact.result.derived = { usage: { inputTokens: 10, outputTokens: 2 } };
  return artifact;
};

function assertPartition(metrics) {
  const v = values(metrics);
  const parts =
    v["attribution.model_ms"] +
    v["attribution.tool_ms"] +
    v["attribution.task_ms"] +
    v["attribution.compaction_ms"] +
    v["attribution.framework_ms"];
  assert.equal(parts, v["latency.turn_ms"], "attribution must add up to non-human turn time");
}

test("derives representative metrics from a captured tool eval", () => {
  const { metrics_version, metrics, failures } = deriveAttemptMetrics(
    fixture("agent-tools-ends-turn-function"),
  );
  assert.equal(metrics_version, METRICS_VERSION);
  assert.deepEqual(Object.keys(metrics).sort(), Object.keys(STANDARD_METRICS).sort());
  assert.deepEqual(failures, []);
  const v = values(metrics);
  assert.equal(v["latency.eval_wall_ms"], 1050);
  assert.equal(v["latency.turn_ms"], 116);
  assert.equal(v["latency.ttft_ms_p50"], 4);
  assert.equal(v["attribution.model_ms"], 17);
  assert.equal(v["attribution.tool_ms"], 3);
  assert.equal(v["attribution.framework_ms"], 96);
  assert.equal(v["tokens.input"], 1117);
  assert.equal(v["tokens.peak_context"], 391);
  assert.equal(v["counts.turns"], 2);
  assert.equal(v["counts.steps"], 3);
  assert.equal(v["counts.tool_calls"], 2);
  // Mock models report no cost: missing cost is unavailable, never zero.
  assert.equal(metrics["cost.primary_usd"].reason, "missing-step-cost");
  assert.equal(metrics["latency.output_tokens_per_s"].reason, "zero-stream-duration");
  assertPartition(metrics);
});

test("attributes delegated work to tasks across repeated captures of one session", () => {
  const { metrics } = deriveAttemptMetrics(fixture("agent-subagents-continuation-local"));
  const v = values(metrics);
  assert.equal(v["attribution.task_ms"], 2465);
  assert.equal(v["attribution.tool_ms"], 133);
  assert.equal(v["counts.turns"], 3, "child sessions are not root turns");
  assert.equal(v["counts.subagent_fan_out"], 1);
  assert.equal(v["counts.subagent_depth"], 1);
  // Rolled-up usage includes the child's spend.
  assert.equal(v["tokens.input"], 6006);
  assertPartition(metrics);
});

test("excludes sign-in wait from latency and counts it as human wait", () => {
  const artifact = synthetic(
    turn(0, 1000, [
      event("authorization.required", 100, { turnId: "t", name: "account" }),
      event("authorization.completed", 274, { turnId: "t", name: "account" }),
    ]),
  );
  artifact.completedAt = at(1072);
  const { metrics } = deriveAttemptMetrics(artifact);
  const v = values(metrics);
  assert.equal(v["attribution.human_wait_ms"], 174);
  assert.equal(v["latency.eval_wall_ms"], 1072 - 174);
  assertPartition(metrics);
});

test("compaction outside a turn does not count toward turn time", () => {
  const { metrics } = deriveAttemptMetrics(compactedArtifact());
  assert.equal(values(metrics)["counts.compactions"], 1);
  assert.equal(values(metrics)["attribution.compaction_ms"], 0);
  assertPartition(metrics);
});

function withCosts(artifact, { stepCost, rolledUpCost }) {
  const copy = structuredClone(artifact);
  // The runner's eval total (result.derived.usage) carries the rolled-up cost.
  copy.result.derived.usage.costUsd = rolledUpCost;
  for (const session of copy.result.sessions) {
    for (const e of session.events) {
      if (session.sessionId !== copy.result.sessionId) continue;
      if (e.type === "step.completed") e.data.usage.costUsd = stepCost;
      if (["session.waiting", "turn.waiting"].includes(e.type)) e.data.usage.costUsd = rolledUpCost;
    }
  }
  return copy;
}

test("splits cost into primary steps and rolled-up subagent spend", () => {
  const artifact = withCosts(fixture("agent-subagents-continuation-local"), {
    stepCost: 0.25,
    rolledUpCost: 4,
  });
  const v = values(deriveAttemptMetrics(artifact).metrics);
  assert.equal(v["cost.primary_usd"], 2.5, "ten primary steps");
  assert.equal(v["cost.total_usd"], 4);
  assert.equal(v["cost.subagent_usd"], 1.5);
});

test("cost and tokens are the runner's eval usage, and unavailable without it", () => {
  const artifact = fixture("agent-tools-ends-turn-function");
  artifact.result.derived.usage = {
    cacheReadTokens: 40,
    cacheWriteTokens: 5,
    inputTokens: 200,
    outputTokens: 12,
    costUsd: 0.75,
  };
  const v = values(deriveAttemptMetrics(artifact).metrics);
  assert.equal(v["cost.total_usd"], 0.75);
  assert.equal(v["tokens.input"], 200);
  assert.equal(v["tokens.output"], 12);
  assert.equal(v["tokens.cache_read"], 40);
  assert.equal(v["tokens.cache_write"], 5);
  assert.equal(v["tokens.cache_hit_ratio"], 0.2);
  // Peak context is per step, from the events, not the eval total.
  assert.equal(v["tokens.peak_context"], 391);

  // A counted session reported no cost: the runner leaves costUsd out.
  delete artifact.result.derived.usage.costUsd;
  const noCost = deriveAttemptMetrics(artifact).metrics;
  assert.deepEqual(noCost["cost.total_usd"], {
    status: "unavailable",
    reason: "missing-rolled-up-cost",
  });
  assert.equal(noCost["tokens.input"].status, "measured");

  // A counted session reported no usage at all: the runner leaves usage out.
  delete artifact.result.derived.usage;
  const none = deriveAttemptMetrics(artifact).metrics;
  for (const key of ["cost.total_usd", "tokens.input", "tokens.output", "tokens.cache_hit_ratio"])
    assert.equal(none[key].status, "unavailable", key);
  assert.equal(none["tokens.peak_context"].status, "measured");
});

test("compaction cost stays in the total but leaves the subagent split unknown", () => {
  // Compaction summary calls are paid and roll up into session usage, but no
  // step reports them: total − steps would misreport them as subagent spend.
  const artifact = withCosts(compactedArtifact(), {
    stepCost: 0.25,
    rolledUpCost: 2,
  });
  const { metrics } = deriveAttemptMetrics(artifact);
  assert.equal(values(metrics)["cost.total_usd"], 2);
  assert.equal(metrics["cost.primary_usd"].status, "measured");
  assert.deepEqual(metrics["cost.subagent_usd"], {
    status: "unavailable",
    reason: "compaction-cost-unattributed",
  });
});

test("a single step without cost makes cost unavailable, and inconsistent rollups are flagged", () => {
  const artifact = withCosts(fixture("agent-tools-ends-turn-function"), {
    stepCost: 1,
    rolledUpCost: 3,
  });
  assert.equal(values(deriveAttemptMetrics(artifact).metrics)["cost.subagent_usd"], 0);

  const inconsistent = withCosts(artifact, { stepCost: 1, rolledUpCost: 2 });
  assert.equal(
    deriveAttemptMetrics(inconsistent).metrics["cost.subagent_usd"].reason,
    "inconsistent-cost-rollup",
  );

  const step = artifact.result.sessions[0].events.find((e) => e.type === "step.completed");
  delete step.data.usage.costUsd;
  const { metrics } = deriveAttemptMetrics(artifact);
  assert.equal(metrics["cost.primary_usd"].reason, "missing-step-cost");
  assert.equal(metrics["cost.subagent_usd"].reason, "missing-step-cost");
  assert.equal(metrics["cost.total_usd"].status, "measured");
});

test("overlapping parallel tools count once and streaming metrics use first deltas", () => {
  const step = { turnId: "t", stepIndex: 0 };
  const events = turn(0, 1000, [
    event("step.started", 100, step),
    event("reasoning.appended", 150, step),
    event("message.appended", 300, step),
    event("actions.requested", 400, {
      ...step,
      actions: [
        { kind: "tool-call", callId: "a" },
        { kind: "tool-call", callId: "b" },
      ],
    }),
    event("action.result", 700, { ...step, result: { callId: "b" }, status: "failed" }),
    event("action.result", 600, { ...step, result: { callId: "a" }, status: "completed" }),
    event("step.completed", 750, { ...step, usage: { outputTokens: 60, inputTokens: 900 } }),
  ]);
  const v = values(deriveAttemptMetrics(synthetic(events)).metrics);
  assert.equal(v["attribution.tool_ms"], 300);
  assert.equal(v["attribution.model_ms"], 350);
  assert.equal(v["attribution.framework_ms"], 350);
  assert.equal(v["latency.ttft_ms_p50"], 50);
  assert.equal(v["latency.output_tokens_per_s"], 100);
  assert.equal(v["reliability.tool_error_rate"], 0.5);
  assert.equal(v["counts.tool_calls_per_step"], 2);
});

test("partial captures make attribution unavailable instead of guessing", () => {
  const openTurn = [
    event("turn.started", 0, { turnId: "t" }),
    event("step.started", 10, { turnId: "t", stepIndex: 0 }),
  ];
  assert.equal(
    deriveAttemptMetrics(synthetic(openTurn)).metrics["attribution.framework_ms"].reason,
    "turn-incomplete",
  );
  const orphanResult = turn(0, 100, [event("action.result", 50, { result: { callId: "x" } })]);
  assert.equal(
    deriveAttemptMetrics(synthetic(orphanResult)).metrics["attribution.tool_ms"].reason,
    "action-start-missing",
  );
  const openInput = turn(0, 100, [
    event("input.requested", 50, { turnId: "unknown", requests: [{ requestId: "r" }] }),
  ]);
  assert.equal(
    deriveAttemptMetrics(synthetic(openInput)).metrics["attribution.human_wait_ms"].reason,
    "input-incomplete",
  );
  const noCapture = { ...synthetic([]), result: { status: "completed" } };
  assert.equal(
    deriveAttemptMetrics(noCapture).metrics["latency.turn_ms"].reason,
    "missing-session-capture",
  );
  const conflicting = synthetic([event("turn.started", 0, { turnId: "t" })]);
  conflicting.result.sessions.push({
    sessionId: "s",
    events: [{ ...conflicting.result.sessions[0].events[0], data: { turnId: "other" } }],
  });
  assert.equal(
    deriveAttemptMetrics(conflicting).metrics["counts.turns"].reason,
    "invalid-session-capture",
  );
});

test("a cancelled turn closes work it abandoned", () => {
  const events = turn(
    0,
    500,
    [
      event("step.started", 10, { turnId: "t", stepIndex: 0 }),
      event("actions.requested", 100, {
        turnId: "t",
        stepIndex: 0,
        actions: [{ kind: "tool-call", callId: "a" }],
      }),
    ],
    "turn.cancelled",
  );
  const v = values(deriveAttemptMetrics(synthetic(events)).metrics);
  assert.equal(v["attribution.tool_ms"], 400);
  assert.equal(v["attribution.model_ms"], 90);
});

test("counts failures by event and code", () => {
  const events = turn(
    0,
    100,
    [
      event("step.started", 10, { turnId: "t", stepIndex: 0 }),
      event("step.failed", 20, { turnId: "t", stepIndex: 0, code: "MODEL_CALL_FAILED" }),
      event("session.failed", 99, { code: "MODEL_CALL_FAILED" }),
    ],
    "turn.failed",
  );
  events.at(-1).data.code = "MODEL_CALL_FAILED";
  const { failures, metrics } = deriveAttemptMetrics(synthetic(events));
  assert.deepEqual(failures, [
    { type: "session.failed", code: "MODEL_CALL_FAILED", count: 1 },
    { type: "step.failed", code: "MODEL_CALL_FAILED", count: 1 },
    { type: "turn.failed", code: "MODEL_CALL_FAILED", count: 1 },
  ]);
  assert.equal(values(metrics)["reliability.step_failures"], 1);
});

test("classifies outcomes and every gap reason", () => {
  const failed = (code, details, message = "failed") =>
    synthetic(
      turn(0, 100, [
        event("step.failed", 50, { turnId: "t", stepIndex: 0, code, details, message }),
      ]),
    );
  const completedStep = event("step.completed", 50, { turnId: "t", stepIndex: 0 });

  assert.deepEqual(classifyOutcome(fixture("agent-tools-ends-turn-function")), {
    outcome: "completed",
  });
  assert.deepEqual(classifyOutcome({ ...synthetic([]), verdict: "skipped" }), {
    outcome: "skipped",
  });
  for (const details of [
    { statusCode: 429 },
    { upstreamStatusCode: 503 },
    { semanticErrorId: "network-request-failed" },
    { detail: "TypeError: fetch failed [cause]: UND_ERR_HEADERS_TIMEOUT" },
  ])
    assert.deepEqual(classifyOutcome(failed("MODEL_CALL_FAILED", details)), {
      outcome: "gap",
      gap_reason: "provider-unavailable",
    });
  for (const details of [{ statusCode: 400 }, { statusCode: 413 }])
    assert.equal(classifyOutcome(failed("MODEL_CALL_FAILED", details)).outcome, "completed");
  assert.equal(classifyOutcome(failed("OUTPUT_SCHEMA_NOT_FULFILLED", {})).outcome, "completed");
  assert.equal(
    classifyOutcome(failed("WORKFLOW_STREAM_WRITE_FAILED", {})).gap_reason,
    "stream-write-failed",
  );

  const timeout = "The operation was aborted due to timeout";
  assert.equal(
    classifyOutcome(synthetic([], { error: timeout })).gap_reason,
    "timeout-before-first-step",
  );
  assert.equal(
    classifyOutcome(synthetic([], { error: "connect ECONNREFUSED" })).gap_reason,
    "error-before-first-step",
  );
  assert.deepEqual(classifyOutcome(synthetic([completedStep], { error: timeout })), {
    outcome: "timed_out",
  });
  // A first step that fails for a real reason is the eval's failure, not a gap,
  // even though the eval then records an error (e.g. from expectOk()).
  for (const details of [{ statusCode: 400 }, { statusCode: 413 }]) {
    const rejected = { ...failed("MODEL_CALL_FAILED", details), error: "expectOk: session failed" };
    assert.deepEqual(classifyOutcome(rejected), { outcome: "completed" });
    assert.deepEqual(classifyOutcome({ ...rejected, error: timeout }), { outcome: "timed_out" });
  }
  const sessionFailed = synthetic([event("session.failed", 40, { code: "SESSION_FAILED" })], {
    error: "expectOk: session failed",
  });
  assert.deepEqual(classifyOutcome(sessionFailed), { outcome: "completed" });
  // Parked is the runner's derived fact (eve's derive-run-facts), not re-derived here.
  const parked = synthetic([completedStep]);
  parked.result.derived = { parked: true };
  assert.deepEqual(classifyOutcome(parked), { outcome: "parked" });
});
