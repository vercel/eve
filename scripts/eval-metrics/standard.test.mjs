import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GAP_REASONS, classifyOutcome } from "./gaps.mjs";
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

test("derives every standard metric for a simple tool eval", () => {
  const { metrics_version, metrics, failures } = deriveAttemptMetrics(
    fixture("agent-tools-ends-turn-function"),
  );
  assert.equal(metrics_version, METRICS_VERSION);
  assert.deepEqual(Object.keys(metrics).sort(), Object.keys(STANDARD_METRICS).sort());
  assert.deepEqual(failures, []);
  assert.deepEqual(values(metrics), {
    "latency.eval_wall_ms": 1050,
    "latency.turn_ms": 116,
    "latency.turn_ms_mean": 58,
    "latency.ttft_ms_p50": 4,
    "latency.output_tokens_per_s": "unavailable",
    "attribution.model_ms": 17,
    "attribution.tool_ms": 3,
    "attribution.task_ms": 0,
    "attribution.human_wait_ms": 0,
    "attribution.compaction_ms": 0,
    "attribution.framework_ms": 96,
    "cost.total_usd": "unavailable",
    "cost.primary_usd": "unavailable",
    "cost.subagent_usd": "unavailable",
    "tokens.input": 1117,
    "tokens.output": 29,
    "tokens.cache_read": 0,
    "tokens.cache_write": 0,
    "tokens.cache_hit_ratio": 0,
    "tokens.peak_context": 391,
    "counts.turns": 2,
    "counts.steps": 3,
    "counts.steps_per_turn": 1.5,
    "counts.tool_calls": 2,
    "counts.tool_calls_per_step": 2 / 3,
    "counts.subagent_fan_out": 0,
    "counts.subagent_depth": 0,
    "counts.compactions": 0,
    "counts.context_clears": 0,
    "reliability.step_failures": 0,
    "reliability.turn_failures": 0,
    "reliability.session_failures": 0,
    "reliability.tool_errors": 0,
    "reliability.tool_error_rate": 0,
    "reliability.truncations": 0,
  });
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
  const { metrics } = deriveAttemptMetrics(fixture("agent-subagents-nested-authorization"));
  const v = values(metrics);
  assert.equal(v["attribution.human_wait_ms"], 174);
  assert.equal(v["latency.eval_wall_ms"], 1072 - 174);
  assertPartition(metrics);
});

test("closes a model step cut off by a session limit at its turn's end", () => {
  const { metrics } = deriveAttemptMetrics(fixture("agent-subagents-usage-limit-tool"));
  assert.equal(metrics["latency.turn_ms"].status, "measured");
  assertPartition(metrics);
});

test("compaction outside a turn does not count toward turn time", () => {
  const { metrics } = deriveAttemptMetrics(fixture("agent-tools-compacted-image"));
  assert.equal(values(metrics)["counts.compactions"], 1);
  assert.equal(values(metrics)["attribution.compaction_ms"], 0);
  assertPartition(metrics);
});

function withCosts(artifact, { stepCost, rolledUpCost }) {
  const copy = structuredClone(artifact);
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
  const parked = synthetic([
    event("turn.started", 0, { turnId: "t" }),
    completedStep,
    event("turn.waiting", 60, { turnId: "t", on: "input" }),
  ]);
  assert.deepEqual(classifyOutcome(parked), { outcome: "parked" });

  assert.deepEqual(GAP_REASONS, [
    "job-missing",
    "eval-missing",
    "provider-unavailable",
    "stream-write-failed",
    "timeout-before-first-step",
    "error-before-first-step",
  ]);
});
