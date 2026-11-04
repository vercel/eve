import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROVIDER_UNAVAILABLE_MESSAGES, classifyOutcome } from "./gaps.mjs";
import { sessionEvents } from "./measurements/events.mjs";
import { listMarks, sessionMarks } from "./measurements/marks.mjs";
import {
  METRICS_VERSION,
  METRIC_DEFINITIONS,
  STANDARD_METRICS,
  deriveAttemptMetrics,
} from "./standard.mjs";

// Fixtures are trimmed `eve eval` detail artifacts captured from mock-model
// runs of e2e/fixtures/agent-tools and agent-subagents (mock models report
// no cost, so cost cases inject it below). `legacy-*` ones predate v27
// session facts (eve before 0.84.0).
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const values = (metrics) =>
  Object.fromEntries(
    Object.entries(metrics).map(([key, m]) => [key, m.status === "measured" ? m.value : m.status]),
  );
const at = (ms) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();

// v27 facts; `synthetic` puts each in its own commit line, in stream order.
const fact = (type, ms, data = {}) => ({ type, data, meta: { at: at(ms) } });
const turn = (start, end, inner, outcome = "completed", turnId = "t") => [
  fact("turn.started", start, { turnId, cause: { deliveryId: `d-${turnId}` } }),
  ...inner,
  fact("turn.settled", end, { turnId, outcome }),
];
const run = (runId, ms, turnId = "t") => [
  fact("model.requested", ms, { runId, owner: { turnId } }),
  fact("model.started", ms, { runId, modelId: "m", attempt: 0 }),
];
const settled = (runId, ms, usage, data = {}) => [
  fact("model.settled", ms, { runId, outcome: "completed", ...data }),
  ...(usage === undefined
    ? []
    : [fact("usage.recorded", ms, { owner: { runId }, kind: "model", usage })]),
];
const call = (callId, runId, ms, kind = "tool") =>
  fact("call.requested", ms, { callId, owner: { runId }, capability: { kind, name: callId } });
const callSettled = (callId, ms, outcome = "completed") =>
  fact("call.settled", ms, { callId, outcome });
// Streamed text, which carries the time of the commit before it (`after`).
const delta = (runId, after, partId = `${runId}.0`, kind = "text") =>
  fact("content.delta", after, { partId, kind, delta: "." });
const completed = (runId, ms, partId = `${runId}.0`, kind = "text") =>
  fact("content.completed", ms, { runId, partId, kind, phase: "reply" });

const synthetic = (events, extra = {}) => ({
  id: "synthetic",
  verdict: "passed",
  startedAt: at(0),
  completedAt: at(1000),
  result: {
    sessionId: "s",
    status: "completed",
    sessions: [
      {
        sessionId: "s",
        primary: true,
        events: events.map((e, line) =>
          typeof e.meta.id === "string"
            ? e
            : { ...e, meta: { ...e.meta, position: { line, index: 0 } } },
        ),
      },
    ],
  },
  ...extra,
});
/** Each event reaches the client `lag` ms after its commit; deltas arrive at `arrivals`. */
const clocked = (events, { lag = 10, arrivals = new Map(), sends = [] } = {}) => {
  const artifact = synthetic(events);
  artifact.result.sessions[0].clock = {
    receivedAt: events.map((e) => arrivals.get(e) ?? Date.parse(e.meta.at) + lag),
    sends,
  };
  return artifact;
};
const compactedArtifact = () => {
  const artifact = synthetic([
    ...turn(0, 100, [...run("r", 10), ...settled("r", 90, { inputTokens: 10, outputTokens: 2 })]),
    fact("context.started", 150, { changeId: "c", kind: "compaction" }),
    fact("model.requested", 151, { runId: "summary", owner: { changeId: "c" } }),
    fact("model.started", 151, { runId: "summary", modelId: "m", attempt: 0 }),
    ...settled("summary", 199, { inputTokens: 50, outputTokens: 8 }),
    fact("context.settled", 200, { changeId: "c", kind: "compaction", outcome: "completed" }),
  ]);
  artifact.result.derived = { usage: { inputTokens: 60, outputTokens: 10 } };
  return artifact;
};

// Recorded eve streams from durable-harness, with the marks and /compare
// breakdown its own code computes (fixtures/durable-harness/generate.mjs).
// They predate v27, so they also cover the upgrade of older captures.
const durableHarness = JSON.parse(
  readFileSync(new URL("./fixtures/durable-harness/expected.json", import.meta.url), "utf8"),
);
const recordedStream = (name) =>
  readFileSync(new URL(`./fixtures/durable-harness/${name}.ndjson`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

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
  assert.equal(v["latency.eval_wall_ms"], 296);
  assert.equal(v["latency.turn_ms"], 92);
  // Model steps run from model.started to model.done: the call, or the last output.
  assert.equal(v["attribution.model_ms"], 25);
  assert.equal(v["attribution.tool_ms"], 8);
  assert.equal(v["attribution.framework_ms"], 59);
  // The last step's delta carries the time of the commit before it; its
  // arrival, less the next commit's delivery lag, places it at 273 ms.
  assert.equal(v["latency.ttft_ms_p50"], 8);
  assert.deepEqual(metrics["overhead.pre_model_ms"].samples, [7, 8]);
  assert.deepEqual(metrics["overhead.model_start_ms"].samples, [1, 2, 2]);
  // The first turn's tool ends its turn, so only the second has a next model call.
  assert.deepEqual(metrics["overhead.tool_hop_ms"].samples, [20]);
  assert.deepEqual(metrics["overhead.finalize_ms"].samples, [12, 12]);
  // On the client clock: the create request and the second message.
  assert.deepEqual(metrics["overhead.first_output_ms"].samples, [120, 109]);
  assert.deepEqual(metrics["overhead.turn_ms"].samples, [126, 132]);
  assert.deepEqual(metrics["overhead.tool_call_ms"].samples, [26]);
  assert.deepEqual(metrics["session.create_ms"].samples, [28]);
  assert.equal(metrics["durability.workflow_steps_per_turn"].reason, "missing-world-probe");
  assert.equal(v["tokens.input"], 1126);
  assert.equal(v["tokens.peak_context"], 394);
  assert.equal(v["counts.steps"], 3);
  assert.equal(v["counts.tool_calls"], 2);
  // Mock models report no cost: missing cost is unavailable, never zero.
  assert.equal(metrics["cost.total_usd"].reason, "missing-rolled-up-cost");
  assertPartition(metrics);
});

test("attributes delegated work to tasks across repeated captures of one session", () => {
  const { metrics } = deriveAttemptMetrics(fixture("agent-subagents-continuation-local"));
  const v = values(metrics);
  // Each agent call from its task handoff to its result.
  assert.equal(v["attribution.task_ms"], 285 + 197 + 2120 + 185 + 144);
  // The agent calls until their handoff, and task waits outside task time.
  assert.equal(v["attribution.tool_ms"], 340);
  assert.equal(v["counts.steps"], 16, "child sessions' steps are not root steps");
  assert.equal(v["counts.tool_calls"], 6, "task waits and cancels, not agent calls");
  // The first agent call's request to its child session's first turn; the
  // second child was never captured.
  assert.deepEqual(metrics["overhead.agent_start_ms"].samples, [289]);
  // Rolled-up usage includes the children's spend.
  assert.equal(v["tokens.input"], 11901);
  assertPartition(metrics);
});

test("a pre-v27 capture measures as it did before eve 0.84.0", () => {
  const tools = deriveAttemptMetrics(fixture("legacy-agent-tools-ends-turn-function")).metrics;
  const v = values(tools);
  assert.equal(v["latency.eval_wall_ms"], 1050);
  assert.equal(v["latency.turn_ms"], 116);
  assert.equal(v["latency.ttft_ms_p50"], 4);
  assert.equal(v["attribution.model_ms"], 15);
  assert.equal(v["attribution.tool_ms"], 3);
  assert.equal(v["attribution.framework_ms"], 98);
  assert.deepEqual(tools["overhead.pre_model_ms"].samples, [2, 0]);
  assert.deepEqual(tools["overhead.tool_hop_ms"].samples, [68]);
  assert.deepEqual(tools["overhead.finalize_ms"].samples, [18, 10]);
  // Artifacts from before eve recorded client timing.
  assert.equal(tools["overhead.turn_ms"].reason, "missing-client-clock");
  assert.equal(v["tokens.peak_context"], 391);
  assert.equal(v["counts.steps"], 3);
  assert.equal(v["counts.tool_calls"], 2);
  // One step start before v27: no request-to-start gap was recorded.
  assert.equal(tools["overhead.model_start_ms"].reason, "predates-model-start");

  const delegated = deriveAttemptMetrics(
    fixture("legacy-agent-subagents-continuation-local"),
  ).metrics;
  // As in v27, an agent call is not a tool call, and its own time ends when
  // its task starts, not at the call's start acknowledgement.
  assert.equal(delegated["counts.tool_calls"].value, 4);
  assert.deepEqual(delegated["overhead.tool_hop_ms"].samples, [16, 0, 18, 1, 0, 16, 1]);
  const subagents = values(delegated);
  assert.equal(subagents["attribution.task_ms"], 2465);
  assert.equal(subagents["attribution.tool_ms"], 133);
  assert.equal(subagents["overhead.agent_start_ms"], 141);
});

test("an attempt from before agent.started delegation measures nothing", () => {
  // eve < 0.69.0: the child session has no `agent.started` link to its parent.
  const legacy = (type, ms, data) => ({ type, data, meta: { id: `${type}@${ms}`, at: at(ms) } });
  const artifact = synthetic([
    legacy("turn.started", 0, { turnId: "t" }),
    legacy("subagent.called", 10, { turnId: "t", callId: "c" }),
    legacy("subagent.completed", 90, { turnId: "t", callId: "c" }),
    legacy("turn.completed", 100, { turnId: "t" }),
  ]);
  artifact.result.sessions.push({
    sessionId: "child",
    events: [legacy("turn.started", 20, { turnId: "t" })].map((e) => ({
      ...e,
      meta: { ...e.meta, id: `child:${e.meta.id}` },
    })),
  });
  const { metrics } = deriveAttemptMetrics(artifact);
  assert.deepEqual(
    new Set(Object.values(metrics).map((m) => m.reason)),
    new Set(["legacy-delegation-events"]),
    "never a measured zero fan-out or child turns counted as root turns",
  );
});

test("excludes a person's wait from latency and counts it as human wait", () => {
  const artifact = synthetic(
    turn(0, 1000, [
      fact("interaction.opened", 100, {
        interactionId: "i",
        subject: { turnId: "t" },
        request: { kind: "sign-in", prompt: "Sign in" },
      }),
      fact("turn.paused", 100, { turnId: "t", awaiting: [{ interactionId: "i" }] }),
      // An invalid answer leaves the question open.
      fact("interaction.settled", 200, { interactionId: "i", outcome: "invalid" }),
      fact("interaction.settled", 274, { interactionId: "i", outcome: "accepted" }),
    ]),
  );
  artifact.completedAt = at(1072);
  const { metrics } = deriveAttemptMetrics(artifact);
  const v = values(metrics);
  assert.equal(v["attribution.human_wait_ms"], 174);
  assert.equal(v["latency.eval_wall_ms"], 1072 - 174);
  assertPartition(metrics);
});

test("compaction outside a turn does not count toward turn time or steps", () => {
  const { metrics } = deriveAttemptMetrics(compactedArtifact());
  const v = values(metrics);
  assert.equal(v["counts.compactions"], 1);
  assert.equal(v["counts.steps"], 1, "the summary run is not a model step");
  assert.equal(v["attribution.compaction_ms"], 0);
  assertPartition(metrics);
});

test("compaction is model work, so no framework overhead counts it", () => {
  const compaction = (changeId, start, end) => [
    fact("context.started", start, { changeId, kind: "compaction", turnId: "t" }),
    fact("context.settled", end, { changeId, kind: "compaction", outcome: "completed" }),
  ];
  const text = delta("r2", 310);
  // Each step compacts between its request and its provider call.
  const events = turn(0, 400, [
    fact("model.requested", 10, { runId: "r1", owner: { turnId: "t" } }),
    ...compaction("c1", 20, 70),
    fact("model.started", 80, { runId: "r1", modelId: "m", attempt: 0 }),
    call("a", "r1", 100),
    ...settled("r1", 110),
    callSettled("a", 200),
    fact("model.requested", 210, { runId: "r2", owner: { turnId: "t" } }),
    ...compaction("c2", 220, 300),
    fact("model.started", 310, { runId: "r2", modelId: "m", attempt: 0 }),
    text,
    completed("r2", 350),
    ...settled("r2", 360),
  ]);
  const zero = Date.parse(at(0));
  const sends = [
    { kind: "message", deliveryId: "d-t", startedAt: zero - 20, notReadyMs: 0, acceptedAt: zero },
  ];
  const arrivals = new Map([[text, Date.parse(at(330))]]);
  const { metrics } = deriveAttemptMetrics(clocked(events, { arrivals, sends }));
  assert.deepEqual(metrics["overhead.pre_model_ms"].samples, [30]);
  assert.deepEqual(metrics["overhead.model_start_ms"].samples, [20, 20]);
  assert.deepEqual(metrics["overhead.tool_hop_ms"].samples, [30]);
  // Send to idle is 430 ms: 60 of model, 100 of tool, and 130 of compaction.
  assert.deepEqual(metrics["overhead.turn_ms"].samples, [140]);
  assert.deepEqual(metrics["overhead.first_output_ms"].samples, [60]);
  assert.deepEqual(metrics["overhead.tool_call_ms"].samples, [30]);
  assert.equal(values(metrics)["attribution.compaction_ms"], 130);
  assertPartition(metrics);
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
  assert.equal(v["tokens.cache_hit_ratio"], 0.2);
  // Peak context is per step, from the facts, not the eval total.
  assert.equal(v["tokens.peak_context"], 394);

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

test("overlapping parallel tools count once and streaming metrics use model marks", () => {
  const reasoning = delta("r", 100, "r.reasoning", "reasoning");
  const text = delta("r", 100);
  const events = turn(0, 1000, [
    ...run("r", 100),
    reasoning,
    text,
    completed("r", 380),
    completed("r", 380, "r.reasoning", "reasoning"),
    call("a", "r", 400),
    call("b", "r", 400),
    callSettled("b", 700, "failed"),
    callSettled("a", 600),
    ...settled("r", 750, { outputTokens: 60, inputTokens: 900 }),
  ]);
  // The deltas were streamed at 150 and 300: their arrivals, less the next commit's lag.
  const arrivals = new Map([
    [reasoning, Date.parse(at(160))],
    [text, Date.parse(at(310))],
  ]);
  const v = values(deriveAttemptMetrics(clocked(events, { arrivals })).metrics);
  assert.equal(v["attribution.tool_ms"], 300);
  assert.equal(v["attribution.model_ms"], 300);
  assert.equal(v["attribution.framework_ms"], 400);
  assert.equal(v["latency.ttft_ms_p50"], 50);
});

test("a delta is placed between the commits around it, and unknown without a client clock", () => {
  const text = delta("r", 100);
  const events = turn(0, 500, [
    ...run("r", 100),
    text,
    completed("r", 300),
    ...settled("r", 300, { outputTokens: 10 }),
  ]);
  // Read in one late batch: its arrival less the smallest lag would land after the next commit.
  const batched = clocked(events, { arrivals: new Map([[text, Date.parse(at(400))]]) });
  assert.equal(values(deriveAttemptMetrics(batched).metrics)["latency.ttft_ms_p50"], 200);
  // Its own time is only the commit before it, which would read as an instant
  // first token; the step streamed, so its TTFT is unknown, not inapplicable.
  assert.deepEqual(deriveAttemptMetrics(synthetic(events)).metrics["latency.ttft_ms_p50"], {
    status: "unavailable",
    reason: "untimed-first-token",
  });
});

test("a retried attempt's streamed output counts though it never completed", () => {
  // v27 names a part's run only on its first delta; a retry abandons the run's parts.
  const abandoned = { ...delta("r1", 100), scope: { runId: "r1", turnId: "t" } };
  const retried = { ...delta("r2", 300), scope: { runId: "r2", turnId: "t" } };
  const events = turn(0, 600, [
    ...run("r1", 100),
    abandoned,
    fact("model.settled", 200, { runId: "r1", outcome: "abandoned" }),
    ...run("r2", 300),
    retried,
    completed("r2", 500),
    ...settled("r2", 500, { outputTokens: 10 }),
  ]);
  const arrivals = new Map([
    [abandoned, Date.parse(at(160))],
    [retried, Date.parse(at(410))],
  ]);
  const zero = Date.parse(at(0));
  const sends = [
    { kind: "message", deliveryId: "d-t", startedAt: zero, notReadyMs: 0, acceptedAt: zero },
  ];
  const { metrics } = deriveAttemptMetrics(clocked(events, { arrivals, sends }));
  // The abandoned run's first token (50 ms) counts, and the client saw output at 160, not 410.
  assert.equal(values(metrics)["latency.ttft_ms_p50"], 75);
  assert.deepEqual(metrics["overhead.first_output_ms"].samples, [110]);
});

test("partial captures make attribution unavailable instead of guessing", () => {
  const openTurn = [fact("turn.started", 0, { turnId: "t" }), ...run("r", 10)];
  assert.equal(
    deriveAttemptMetrics(synthetic(openTurn)).metrics["attribution.framework_ms"].reason,
    "turn-incomplete",
  );
  const orphanResult = turn(0, 100, [callSettled("x", 50)]);
  assert.equal(
    deriveAttemptMetrics(synthetic(orphanResult)).metrics["attribution.tool_ms"].reason,
    "action-start-missing",
  );
  const openInteraction = turn(0, 100, [
    fact("interaction.opened", 50, { interactionId: "i", subject: { turnId: "unknown" } }),
  ]);
  assert.equal(
    deriveAttemptMetrics(synthetic(openInteraction)).metrics["attribution.human_wait_ms"].reason,
    "interaction-incomplete",
  );
  const noCapture = { ...synthetic([]), result: { status: "completed" } };
  assert.equal(
    deriveAttemptMetrics(noCapture).metrics["latency.turn_ms"].reason,
    "missing-session-capture",
  );
  const conflicting = synthetic([fact("turn.started", 0, { turnId: "t" })]);
  conflicting.result.sessions.push({
    sessionId: "s",
    events: [{ ...conflicting.result.sessions[0].events[0], data: { turnId: "other" } }],
  });
  assert.equal(
    deriveAttemptMetrics(conflicting).metrics["counts.steps"].reason,
    "invalid-session-capture",
  );
});

test("a cancelled turn closes work it abandoned", () => {
  const events = turn(0, 500, [...run("r", 10), call("a", "r", 100)], "cancelled");
  const v = values(deriveAttemptMetrics(synthetic(events)).metrics);
  assert.equal(v["attribution.tool_ms"], 400);
  assert.equal(v["attribution.model_ms"], 90);
});

test("counts failures by kind and code", () => {
  const error = { code: "MODEL_CALL_FAILED", message: "failed" };
  const events = [
    ...turn(
      0,
      100,
      [...run("r", 10), fact("model.settled", 20, { runId: "r", outcome: "failed", error })],
      "failed",
    ),
    fact("session.ended", 100, { outcome: "failed", error }),
  ];
  events.find((e) => e.type === "turn.settled").data.error = error;
  const { failures, metrics } = deriveAttemptMetrics(synthetic(events));
  assert.deepEqual(failures, [
    { type: "session.failed", code: "MODEL_CALL_FAILED", count: 1 },
    { type: "step.failed", code: "MODEL_CALL_FAILED", count: 1 },
    { type: "turn.failed", code: "MODEL_CALL_FAILED", count: 1 },
  ]);
  assert.equal(values(metrics)["reliability.turn_failures"], 1);
});

test("provider-unavailable messages are eve's own wording", () => {
  const rules = ["gateway.ts", "system.ts"]
    .map((name) =>
      readFileSync(
        new URL(`../../packages/eve/src/harness/semantic-errors/rules/${name}`, import.meta.url),
        "utf8",
      ),
    )
    .join("\n");
  for (const message of PROVIDER_UNAVAILABLE_MESSAGES)
    assert(rules.includes(message), `eve no longer words a failure "${message}"`);
});

test("classifies outcomes and every gap reason", () => {
  const failed = (code, message = "failed") =>
    synthetic(
      turn(
        0,
        100,
        [
          ...run("r", 10),
          fact("model.settled", 50, { runId: "r", outcome: "failed", error: { code, message } }),
        ],
        "failed",
      ),
    );
  const completedStep = [...run("r", 10), ...settled("r", 50)];

  assert.deepEqual(classifyOutcome(fixture("agent-tools-ends-turn-function")), {
    outcome: "completed",
  });
  assert.deepEqual(classifyOutcome({ ...synthetic([]), verdict: "skipped" }), {
    outcome: "skipped",
  });
  for (const message of [
    "AI Gateway rate-limited the request.",
    "The model provider is overloaded or timing out upstream of AI Gateway.",
    "A network request failed before completing (ECONNRESET).",
    "fetch failed: UND_ERR_HEADERS_TIMEOUT",
    // Transient statuses eve has no rule for keep the provider's status text.
    "Service Unavailable",
    "Too Many Requests",
  ])
    assert.deepEqual(classifyOutcome(failed("MODEL_CALL_FAILED", message)), {
      outcome: "gap",
      gap_reason: "provider-unavailable",
    });
  // Before v27, failures carried the provider's status instead.
  const legacyFailure = (details) =>
    synthetic(
      [
        ["step.started", {}],
        ["step.failed", { code: "MODEL_CALL_FAILED", message: "failed", details }],
      ].map(([type, data], i) => ({
        type,
        data: { turnId: "t", stepIndex: 0, ...data },
        meta: { id: `${type}:${JSON.stringify(details)}`, at: at(10 + i) },
      })),
    );
  assert.equal(
    classifyOutcome(legacyFailure({ statusCode: 429 })).gap_reason,
    "provider-unavailable",
  );
  assert.equal(classifyOutcome(legacyFailure({ statusCode: 400 })).outcome, "completed");
  assert.equal(
    classifyOutcome(failed("MODEL_CALL_FAILED", "The request exceeded the context window."))
      .outcome,
    "completed",
  );
  assert.equal(classifyOutcome(failed("OUTPUT_SCHEMA_NOT_FULFILLED")).outcome, "completed");
  assert.equal(
    classifyOutcome(failed("WORKFLOW_STREAM_WRITE_FAILED")).gap_reason,
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
  assert.deepEqual(classifyOutcome(synthetic(completedStep, { error: timeout })), {
    outcome: "timed_out",
  });
  // A first step that fails for a real reason is the eval's failure, not a gap,
  // even though the eval then records an error (e.g. from expectOk()).
  const rejected = { ...failed("MODEL_CALL_FAILED"), error: "expectOk: session failed" };
  assert.deepEqual(classifyOutcome(rejected), { outcome: "completed" });
  assert.deepEqual(classifyOutcome({ ...rejected, error: timeout }), { outcome: "timed_out" });
  const sessionFailed = synthetic(
    [
      fact("session.ended", 40, {
        outcome: "failed",
        error: { code: "SESSION_FAILED", message: "" },
      }),
    ],
    { error: "expectOk: session failed" },
  );
  assert.deepEqual(classifyOutcome(sessionFailed), { outcome: "completed" });
  // Parked is the runner's derived fact (eve's derive-run-facts), not re-derived here.
  const parked = synthetic(completedStep);
  parked.result.derived = { parked: true };
  assert.deepEqual(classifyOutcome(parked), { outcome: "parked" });
});

for (const [name, expected] of Object.entries(durableHarness.fixtures)) {
  test(`matches durable-harness's marks and /compare overheads on ${name}`, () => {
    assert.equal(durableHarness.commit, METRIC_DEFINITIONS.commit);
    const events = recordedStream(name);
    const byTime = (a, b) => a.t - b.t || a.name.localeCompare(b.name);
    assert.deepEqual(
      listMarks(sessionMarks(sessionEvents({ events }))).sort(byTime),
      expected.marks
        .map((mark) => ({ ...mark, key: mark.key?.replace(/:(\d+)$/, "/$1") ?? null }))
        .sort(byTime),
    );

    const artifact = synthetic(events);
    artifact.result.sessions[0].clock = expected.clock;
    const { metrics } = deriveAttemptMetrics(artifact);
    const samples = (key) => metrics[key].samples;
    const { turn, clock } = expected;
    assert.deepEqual(samples("overhead.first_output_ms"), [turn.firstOutputOverheadMs]);
    assert.deepEqual(samples("overhead.turn_ms"), [turn.turnOverheadMs]);
    assert.deepEqual(
      samples("overhead.tool_call_ms"),
      turn.tools.map((tool) => tool.overheadMs),
    );
    assert.deepEqual(
      samples("overhead.tool_hop_ms"),
      turn.tools.map((tool) => tool.oursMs),
    );
    assert.equal(metrics["attribution.model_ms"].value, turn.turnModelMs);
    const [prewarm, ...messages] = clock.sends;
    assert.deepEqual(
      samples("session.not_ready_ms"),
      messages.map((send) => send.notReadyMs),
    );
    assert.deepEqual(samples("session.create_ms"), [prewarm.acceptedAt - prewarm.startedAt]);
  });
}

test("concurrent tools count once in turn overhead, and a batch is one tool hop", () => {
  const zero = Date.parse(at(0));
  const sends = [
    { kind: "message", deliveryId: "d-t", startedAt: zero - 20, notReadyMs: 0, acceptedAt: zero },
  ];
  // eve may stream text between one step's calls.
  const narration = [delta("r1", 400, "r1.1"), delta("r1", 410, "r1.2")];
  const done = delta("r2", 950, "r2.0");
  const arrivals = new Map([
    [narration[0], Date.parse(at(415))],
    [narration[1], Date.parse(at(425))],
    [done, Date.parse(at(1010))],
  ]);
  const events = turn(0, 1200, [
    ...run("r1", 100),
    call("a", "r1", 400),
    narration[0],
    completed("r1", 410, "r1.1"),
    call("b", "r1", 410),
    narration[1],
    completed("r1", 420, "r1.2"),
    call("c", "r1", 420),
    ...settled("r1", 430),
    callSettled("a", 500),
    callSettled("c", 600),
    callSettled("b", 900),
    ...run("r2", 950),
    done,
    completed("r2", 1000),
    ...settled("r2", 1100),
  ]);
  const { metrics } = deriveAttemptMetrics(clocked(events, { arrivals, sends }));
  // The tools ran from 400 to 900: 500 ms, not the 770 ms their durations add
  // up to. The rest is sent→first request (130), last tool→next request (50),
  // and the second step's output→idle (200).
  assert.deepEqual(metrics["overhead.turn_ms"].samples, [380]);
  // One hop for the batch, from model.done at 400 to the next request at 950.
  assert.deepEqual(metrics["overhead.tool_hop_ms"].samples, [50]);
  assert.deepEqual(metrics["overhead.tool_call_ms"].samples, [50]);

  // The next model call waits for every call, so a batch with an unfinished
  // call has no hop to measure.
  const unfinished = events.filter((e) => !(e.type === "call.settled" && e.data.callId === "b"));
  const partial = deriveAttemptMetrics(clocked(unfinished, { arrivals, sends })).metrics;
  assert.equal(partial["overhead.tool_hop_ms"].reason, "no-tool-hops");
  assert.equal(partial["overhead.tool_call_ms"].reason, "no-tool-hops");

  // Two batches: one step requesting two calls, then a step whose first
  // output is its own call. The second hop starts at the later of that step's
  // model.done and the first batch's tool ends.
  const last = delta("r3", 850, "r3.0");
  const twoBatches = turn(0, 1000, [
    ...run("r1", 100),
    call("a", "r1", 400),
    call("b", "r1", 400),
    ...settled("r1", 410),
    callSettled("a", 500),
    callSettled("b", 600),
    ...run("r2", 650),
    call("c", "r2", 700),
    ...settled("r2", 710),
    callSettled("c", 800),
    ...run("r3", 850),
    last,
    completed("r3", 900),
    ...settled("r3", 950),
  ]);
  const both = deriveAttemptMetrics(
    clocked(twoBatches, { arrivals: new Map([[last, Date.parse(at(910))]]), sends }),
  ).metrics;
  // 1030 from send to idle, less 400 of model and 300 of tools.
  assert.deepEqual(both["overhead.turn_ms"].samples, [330]);
  assert.deepEqual(both["overhead.tool_hop_ms"].samples, [50, 50]);
  assert.deepEqual(both["overhead.tool_call_ms"].samples, [50, 50]);
});

test("a session created with its first message times that turn from the create request", () => {
  const { clock, turn } = durableHarness.fixtures["eve-tool-turn"];
  const message = clock.sends.find((send) => send.kind === "message");
  const artifact = synthetic(recordedStream("eve-tool-turn"));
  // The create request carries no delivery id; its turn is the session's first.
  const startedAt = message.startedAt - 30;
  artifact.result.sessions[0].clock = {
    receivedAt: clock.receivedAt,
    sends: [{ kind: "create", startedAt, notReadyMs: 0, acceptedAt: message.acceptedAt }],
  };
  const { metrics } = deriveAttemptMetrics(artifact);
  assert.deepEqual(metrics["overhead.first_output_ms"].samples, [turn.firstOutputOverheadMs + 30]);
  assert.deepEqual(metrics["session.create_ms"].samples, [message.acceptedAt - startedAt]);
  assert.equal(metrics["session.not_ready_ms"].reason, "no-message-sends");
});
