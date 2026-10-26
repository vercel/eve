// Standard per-attempt metric set derived from one eval detail artifact
// (`.eve/evals/<ts>/evals/<id>.json`). STANDARD_METRICS below lists every
// metric with its unit and better direction.
//
// Scope: latency, attribution, step-level cost, and efficiency counts read the
// eval's root sessions (sessions the eval opened, not delegated children).
// Reliability counts read every captured session, because a failure anywhere
// matters.
//
// Cost and tokens: `cost.total_usd` and `tokens.*` (but `tokens.peak_context`)
// are the runner's `result.derived.usage`, the same totals the eval reporters
// see: each captured session's latest usage, including delegated work and
// compaction summaries, less sessions another captured session opened.
// `cost.primary_usd` sums the root sessions' model steps; `cost.subagent_usd`
// is the difference, and is unavailable when a root session compacted, since
// compaction cost is in the total but in no step.
//
// Attribution partitions root turn time with a fixed precedence, so the parts
// add up to the turn total: human wait, then task (delegated work, including
// time a `task_wait` call blocks on it), tool (any other requested action),
// compaction, model step, and the remainder is framework time. In-process
// tools run inside their model step, so precedence keeps model ms to model work.
// A model step ends at durable-harness's `model.done` mark (the tool calls
// streamed in full, or the step's last output), not at `step.completed`:
// recording a finished response is framework time, as it is on /compare.
//
// Framework overhead (`overhead.*`, `session.*`, `durability.*`) is derived in
// framework.mjs. Every metric has a scope: `model` metrics trend per model;
// `framework` metrics trend per world and model class (mock or live), and the
// `pooled` ones are normalized per unit of work, so live legs may pool them
// across models.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureSessions,
  notApplicable,
  selectEvents,
  unavailable,
} from "./measurements/events.mjs";
import { clientOverheads, durability, median, serverOverheads } from "./framework.mjs";
import { coveredLengthBetween, pairIntervals, stepKey } from "./measurements/intervals.mjs";
import { sessionMarks } from "./measurements/marks.mjs";

/** Bump whenever a definition below changes meaning. */
export const METRICS_VERSION = 3;

/**
 * Where the framework definitions come from. The conformance data in
 * fixtures/durable-harness/ was generated from this commit. `deviations`
 * ships in every manifest, so a reader comparing with /compare sees where
 * eve's values mean something else (see framework.mjs).
 */
export const METRIC_DEFINITIONS = Object.freeze({
  repository: "vercel-labs/durable-harness",
  path: "packages/demo-ui/src/compare-glossary.ts",
  commit: "ea8aa4060cf4fb8cd39737ce8ab21c4e0f40c741",
  deviations: Object.freeze({
    "overhead.turn_ms": "concurrent tool time counts once",
    "overhead.tool_hop_ms": "one sample per batch of calls a model step requested",
    "overhead.tool_call_ms": "one sample per batch of calls a model step requested",
  }),
});

const model = (unit, direction) => ({ unit, direction, scope: "model" });
/** `per`: the value is the attempt's p50 over that occurrence, with `count` and `samples`. */
const framework = (unit, direction, { per, pooled }) => ({
  unit,
  direction,
  scope: "framework",
  ...(per === undefined ? {} : { per }),
  pooled,
});

/** Every metric in the standard set: unit, better direction, and scope. */
export const STANDARD_METRICS = Object.freeze({
  "latency.eval_wall_ms": model("ms", "lower"),
  "latency.turn_ms": model("ms", "lower"),
  "latency.turn_ms_mean": model("ms", "lower"),
  "latency.ttft_ms_p50": model("ms", "lower"),
  "latency.output_tokens_per_s": model("tokens/s", "higher"),
  "attribution.model_ms": model("ms", "lower"),
  "attribution.tool_ms": model("ms", "lower"),
  "attribution.task_ms": model("ms", "lower"),
  "attribution.human_wait_ms": model("ms", "neutral"),
  "attribution.compaction_ms": model("ms", "lower"),
  "attribution.framework_ms": framework("ms", "lower", { pooled: false }),
  "overhead.pre_model_ms": framework("ms", "lower", { per: "turn", pooled: true }),
  "overhead.tool_hop_ms": framework("ms", "lower", { per: "batch", pooled: true }),
  "overhead.finalize_ms": framework("ms", "lower", { per: "turn", pooled: true }),
  "overhead.agent_start_ms": framework("ms", "lower", { per: "call", pooled: true }),
  "overhead.first_output_ms": framework("ms", "lower", { per: "turn", pooled: true }),
  "overhead.turn_ms": framework("ms", "lower", { per: "turn", pooled: true }),
  "overhead.tool_call_ms": framework("ms", "lower", { per: "batch", pooled: true }),
  "session.not_ready_ms": framework("ms", "lower", { per: "send", pooled: true }),
  "session.create_ms": framework("ms", "lower", { per: "session", pooled: true }),
  "durability.workflow_steps_per_turn": framework("ratio", "lower", { pooled: true }),
  "durability.step_input_bytes_per_turn": framework("bytes", "lower", { pooled: true }),
  "durability.step_output_bytes_per_turn": framework("bytes", "lower", { pooled: true }),
  "durability.workflow_steps_per_model_step": framework("ratio", "lower", { pooled: true }),
  "cost.total_usd": model("usd", "lower"),
  "cost.primary_usd": model("usd", "lower"),
  "cost.subagent_usd": model("usd", "lower"),
  "tokens.input": model("tokens", "lower"),
  "tokens.output": model("tokens", "lower"),
  "tokens.cache_read": model("tokens", "neutral"),
  "tokens.cache_write": model("tokens", "neutral"),
  "tokens.cache_hit_ratio": model("ratio", "higher"),
  "tokens.peak_context": model("tokens", "lower"),
  "counts.turns": model("count", "neutral"),
  "counts.steps": model("count", "lower"),
  "counts.steps_per_turn": model("ratio", "lower"),
  "counts.tool_calls": model("count", "neutral"),
  "counts.tool_calls_per_step": model("ratio", "neutral"),
  "counts.subagent_fan_out": model("count", "neutral"),
  "counts.subagent_depth": model("count", "neutral"),
  "counts.compactions": model("count", "lower"),
  "counts.context_clears": model("count", "neutral"),
  "reliability.step_failures": model("count", "lower"),
  "reliability.turn_failures": model("count", "lower"),
  "reliability.session_failures": model("count", "lower"),
  "reliability.tool_errors": model("count", "lower"),
  "reliability.tool_error_rate": model("ratio", "lower"),
  "reliability.truncations": model("count", "lower"),
});

const TURN_TERMINALS = ["turn.completed", "turn.failed", "turn.cancelled"];
const FAILURE_EVENTS = ["step.failed", "turn.failed", "session.failed"];
const TOOL_ACTION_KINDS = new Set(["tool-call", "workflow-tool-call"]);

/**
 * @param {object} evalArtifact parsed eval detail JSON
 * @param {{ world?: Map<string, { events: object[] }> }} [probes] the leg's
 *   world probe, by session id; absent when the leg exported none
 * @returns {{
 *   metrics_version: number,
 *   metrics: Record<string, import("./measurements/events.mjs").Measurement>,
 *   failures: { type: string, code: string, count: number }[],
 * }}
 */
export function deriveAttemptMetrics(evalArtifact, { world } = {}) {
  const sessions = evalArtifact?.result?.sessions;
  let capture;
  try {
    capture = captureSessions(
      Array.isArray(sessions)
        ? sessions.filter((session) => typeof session?.sessionId === "string")
        : undefined,
    );
  } catch {
    return everyMetric(unavailable("invalid-session-capture"));
  }
  if (capture === undefined) return everyMetric(unavailable("missing-session-capture"));
  if (capture.bySession.size === 0) return everyMetric(notApplicable("no-sessions"));

  const rootIds = rootSessionIds(capture);
  if (rootIds.length === 0) return everyMetric(unavailable("missing-root-session"));
  const roots = rootIds.map((sessionId) => {
    const events = capture.bySession.get(sessionId);
    const marks = sessionMarks(events);
    return { sessionId, events, marks, timeline: sessionTimeline(capture, sessionId, marks) };
  });
  const allEvents = capture.events;

  const metrics = {
    ...latencyAndAttribution(evalArtifact, roots),
    ...serverOverheads(roots, capture.bySession),
    ...clientOverheads(sessions, roots),
    ...durability(roots, world),
    ...streaming(roots),
    ...costAndTokens(evalArtifact, roots),
    ...efficiency(capture, roots, rootIds),
    ...reliability(allEvents),
  };
  return { metrics_version: METRICS_VERSION, metrics, failures: failureCodes(allEvents) };
}

function everyMetric(measurement) {
  return {
    metrics_version: METRICS_VERSION,
    metrics: Object.fromEntries(Object.keys(STANDARD_METRICS).map((key) => [key, measurement])),
    failures: [],
  };
}

function measured(value) {
  return { status: "measured", value };
}

/** Sessions the eval opened itself: neither linked by `agent.started` nor invoked as a subagent. */
function rootSessionIds(capture) {
  const children = new Set(
    selectEvents(capture.events, "agent.started").map((event) => event.data?.sessionId),
  );
  for (const [sessionId, events] of capture.bySession) {
    if (
      selectEvents(events, "session.started").some((e) => e.data?.invocation?.kind === "subagent")
    )
      children.add(sessionId);
  }
  return [...capture.bySession.keys()].filter((sessionId) => !children.has(sessionId));
}

/** Pair every interval family of one session, clipping nothing yet. */
function sessionTimeline(capture, sessionId, marks) {
  const events = capture.bySession.get(sessionId);
  const turnStarts = selectEvents(events, "turn.started");
  const turnKey = (e) => [e.data?.turnId];
  // A root session with no turns has no turn time to attribute; without this,
  // every latency and attribution part would read as a measured zero.
  const turns =
    turnStarts.length === 0
      ? unavailable("missing-turn")
      : pairIntervals(
          turnStarts,
          TURN_TERMINALS.flatMap((type) => selectEvents(events, type)),
          { startKeys: turnKey, endKeys: turnKey, subject: "turn" },
        );
  const terminals = new Map(
    turns.status === "ready" ? turns.intervals.map((turn) => [turn.key, turn.end]) : [],
  );
  // Work a turn abandons (a cancelled turn, a step cut off by a session
  // limit) ends with that turn.
  const closeOpen = (start) => terminals.get(start.data?.turnId);

  const steps = endStepsAtModelDone(
    pairIntervals(
      selectEvents(events, "step.started"),
      [...selectEvents(events, "step.completed"), ...selectEvents(events, "step.failed")],
      { startKeys: (e) => [stepKey(e)], endKeys: (e) => [stepKey(e)], subject: "step", closeOpen },
    ),
    marks,
  );
  const actions = pairIntervals(
    selectEvents(events, "actions.requested"),
    selectEvents(events, "action.result"),
    {
      startKeys: (e) =>
        Array.isArray(e.data?.actions) ? e.data.actions.map((a) => a?.callId) : [],
      endKeys: (e) => [e.data?.result?.callId],
      subject: "action",
      repeatedStarts: "earliest",
      closeOpen,
    },
  );
  const taskKey = (e) => [taskIdentity(e)];
  const tasks = pairIntervals(
    selectEvents(events, "task.started"),
    selectEvents(events, "task.settled"),
    { startKeys: taskKey, endKeys: taskKey, subject: "task", closeOpen },
  );
  const compactions = pairIntervals(
    selectEvents(events, "compaction.requested"),
    selectEvents(events, "compaction.completed"),
    {
      startKeys: (e) => [stepKey(e)],
      endKeys: (e) => [stepKey(e)],
      subject: "compaction",
      closeOpen,
    },
  );
  return {
    events,
    turns,
    steps,
    actions,
    tasks,
    compactions,
    human: humanWait(events, closeOpen),
  };
}

function endStepsAtModelDone(steps, marks) {
  if (steps.status !== "ready") return steps;
  if (marks.status !== "ready") return marks;
  const done = new Map(
    [...marks.turns.values()].flatMap((turn) => turn.steps.map((step) => [step.key, step.done])),
  );
  return {
    status: "ready",
    intervals: steps.intervals.map((interval) => {
      const doneAt = done.get(interval.key)?.t;
      return doneAt === undefined || doneAt < interval.startAt || doneAt > interval.endAt
        ? interval
        : { ...interval, endAt: doneAt };
    }),
  };
}

function taskIdentity(event) {
  const { taskId, callId } = event.data ?? {};
  return typeof taskId === "string" && typeof callId === "string"
    ? `${taskId}/${callId}`
    : undefined;
}

/** Input requests, responder-bound approvals, and sign-ins, from request to resolution. */
function humanWait(events, closeOpen) {
  const requestIds = (list) => (Array.isArray(list) ? list.map((entry) => entry?.requestId) : []);
  const settledResolutions = (event) =>
    (event.data?.resolutions ?? []).filter((resolution) => resolution?.outcome !== "invalid");
  const input = pairIntervals(
    selectEvents(events, "input.requested"),
    selectEvents(events, "input.resolved").filter((e) => settledResolutions(e).length > 0),
    {
      startKeys: (e) => requestIds(e.data?.requests),
      endKeys: (e) => requestIds(settledResolutions(e)),
      subject: "input",
      closeOpen,
    },
  );

  // `approval.settled` also closes approvals delivered only through
  // `input.requested`; only responder-bound candidates open an interval here.
  const candidates = selectEvents(events, "approval.candidate", { outcome: "pending" });
  const candidateIds = new Set(candidates.map((e) => e.data?.requestId));
  const approval = pairIntervals(
    candidates,
    selectEvents(events, "approval.settled").filter((e) => candidateIds.has(e.data?.requestId)),
    {
      startKeys: (e) => [e.data?.requestId],
      endKeys: (e) => [e.data?.requestId],
      subject: "approval",
      repeatedStarts: "earliest",
      closeOpen,
    },
  );

  // `attemptId` is not present on every `authorization.required`, so key by
  // the turn and connection name, which both events always carry.
  const authorizationKey = (e) =>
    typeof e.data?.turnId === "string" && typeof e.data?.name === "string"
      ? [`${e.data.turnId}/${e.data.name}`]
      : [];
  const authorization = pairIntervals(
    selectEvents(events, "authorization.required"),
    selectEvents(events, "authorization.completed"),
    {
      startKeys: authorizationKey,
      endKeys: authorizationKey,
      subject: "authorization",
      repeatedStarts: "earliest",
      closeOpen,
    },
  );

  for (const family of [input, approval, authorization])
    if (family.status !== "ready") return family;
  return {
    status: "ready",
    intervals: [...input.intervals, ...approval.intervals, ...authorization.intervals],
  };
}

function latencyAndAttribution(evalArtifact, roots) {
  const parts = {
    turn: [],
    human: [],
    tool: [],
    task: [],
    compaction: [],
    model: [],
    framework: [],
  };
  let failure;
  let turnCount = 0;
  const humanIntervals = [];
  for (const { timeline } of roots) {
    const families = ["turns", "human", "actions", "tasks", "compactions", "steps"];
    const broken = families.map((name) => timeline[name]).find((f) => f.status !== "ready");
    if (broken !== undefined) {
      failure ??= broken;
      continue;
    }
    const T = timeline.turns.intervals;
    const H = timeline.human.intervals;
    const A = timeline.actions.intervals;
    const K = timeline.tasks.intervals;
    const C = timeline.compactions.intervals;
    const M = timeline.steps.intervals;
    const total = coveredLengthBetween(T);
    const human = coveredLengthBetween(H, { within: T });
    parts.turn.push(total - human);
    parts.human.push(human);
    parts.task.push(coveredLengthBetween(K, { within: T, excluding: H }));
    parts.tool.push(coveredLengthBetween(A, { within: T, excluding: [...H, ...K] }));
    parts.compaction.push(coveredLengthBetween(C, { within: T, excluding: [...H, ...A, ...K] }));
    parts.model.push(coveredLengthBetween(M, { within: T, excluding: [...H, ...A, ...K, ...C] }));
    parts.framework.push(
      total - coveredLengthBetween([...H, ...A, ...K, ...C, ...M], { within: T }),
    );
    turnCount += T.length;
    humanIntervals.push(...H);
  }

  const sum = (values) => (failure ? failure : measured(values.reduce((a, b) => a + b, 0)));
  return {
    "latency.eval_wall_ms": failure ?? evalWall(evalArtifact, humanIntervals),
    "latency.turn_ms": sum(parts.turn),
    "latency.turn_ms_mean":
      failure ??
      (turnCount === 0
        ? notApplicable("no-turns")
        : measured(parts.turn.reduce((a, b) => a + b, 0) / turnCount)),
    "attribution.model_ms": sum(parts.model),
    "attribution.tool_ms": sum(parts.tool),
    "attribution.task_ms": sum(parts.task),
    "attribution.human_wait_ms": sum(parts.human),
    "attribution.compaction_ms": sum(parts.compaction),
    "attribution.framework_ms": sum(parts.framework),
  };
}

function evalWall(evalArtifact, humanIntervals) {
  const startAt = Date.parse(evalArtifact?.startedAt ?? "");
  const endAt = Date.parse(evalArtifact?.completedAt ?? "");
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt))
    return unavailable("missing-eval-timing");
  if (endAt < startAt) return unavailable("negative-duration");
  const human = coveredLengthBetween(humanIntervals, { within: [{ startAt, endAt }] });
  return measured(endAt - startAt - human);
}

/** Time to first token and output rate per model step, from its marks. */
function streaming(roots) {
  const broken = roots.find(({ marks }) => marks.status !== "ready");
  if (broken !== undefined)
    return { "latency.ttft_ms_p50": broken.marks, "latency.output_tokens_per_s": broken.marks };
  const ttfts = [];
  let tokens = 0;
  let streamMs = 0;
  let missingTokens = false;
  for (const { events, marks } of roots) {
    const completions = new Map(
      selectEvents(events, "step.completed").map((event) => [stepKey(event), event]),
    );
    for (const turn of marks.turns.values()) {
      for (const step of turn.steps) {
        if (step.firstToken === undefined) continue;
        ttfts.push(step.firstToken.t - step.request.t);
        const completed = completions.get(step.key);
        if (completed === undefined || step.done === undefined) continue;
        const outputTokens = completed.data?.usage?.outputTokens;
        if (typeof outputTokens !== "number") missingTokens = true;
        else tokens += outputTokens;
        streamMs += Math.max(0, step.done.t - step.firstToken.t);
      }
    }
  }
  if (ttfts.length === 0) {
    const none = notApplicable("no-streamed-steps");
    return { "latency.ttft_ms_p50": none, "latency.output_tokens_per_s": none };
  }
  return {
    "latency.ttft_ms_p50": measured(median(ttfts)),
    "latency.output_tokens_per_s": missingTokens
      ? unavailable("missing-output-tokens")
      : streamMs <= 0
        ? unavailable("zero-stream-duration")
        : measured((tokens / streamMs) * 1000),
  };
}

function costAndTokens(evalArtifact, roots) {
  const steps = roots.flatMap(({ events }) => selectEvents(events, "step.completed"));
  // Absent when a counted session reported no usage; `costUsd` is absent when
  // one reported no cost (eve's evalUsage).
  const usage = evalArtifact?.result?.derived?.usage;

  let primary;
  if (steps.length === 0) primary = notApplicable("no-model-steps");
  else if (steps.some((step) => !isAmount(step.data?.usage?.costUsd)))
    primary = unavailable("missing-step-cost");
  else primary = measured(steps.reduce((total, step) => total + step.data.usage.costUsd, 0));

  const rolled = (field, reason) =>
    isAmount(usage?.[field]) ? measured(usage[field]) : unavailable(reason);
  const total = rolled("costUsd", "missing-rolled-up-cost");

  // Compaction summary calls add their cost to the session's rolled-up usage,
  // but no step event reports it, so total − steps would count it as
  // subagent spend. Until compaction events carry usage, the split is unknown.
  const compacted = roots.some(
    ({ events }) => selectEvents(events, "compaction.completed").length > 0,
  );
  let subagent;
  if (total.status !== "measured") subagent = total;
  else if (compacted) subagent = unavailable("compaction-cost-unattributed");
  else if (primary.status === "not-applicable") subagent = total;
  else if (primary.status !== "measured") subagent = primary;
  else {
    const difference = total.value - primary.value;
    // Float sums of identical costs can differ in the last bits.
    subagent =
      difference < -1e-9
        ? unavailable("inconsistent-cost-rollup")
        : measured(Math.max(0, difference));
  }

  const input = rolled("inputTokens", "missing-rolled-up-usage");
  const cacheRead = rolled("cacheReadTokens", "missing-rolled-up-usage");
  let cacheHitRatio;
  if (input.status !== "measured") cacheHitRatio = input;
  else if (cacheRead.status !== "measured") cacheHitRatio = cacheRead;
  else if (input.value === 0) cacheHitRatio = notApplicable("no-input-tokens");
  else cacheHitRatio = measured(cacheRead.value / input.value);

  let peak;
  if (steps.length === 0) peak = notApplicable("no-model-steps");
  else if (steps.some((step) => !isAmount(step.data?.usage?.inputTokens)))
    peak = unavailable("missing-step-input-tokens");
  else peak = measured(Math.max(...steps.map((step) => step.data.usage.inputTokens)));

  return {
    "cost.total_usd": total,
    "cost.primary_usd": primary,
    "cost.subagent_usd": subagent,
    "tokens.input": input,
    "tokens.output": rolled("outputTokens", "missing-rolled-up-usage"),
    "tokens.cache_read": cacheRead,
    "tokens.cache_write": rolled("cacheWriteTokens", "missing-rolled-up-usage"),
    "tokens.cache_hit_ratio": cacheHitRatio,
    "tokens.peak_context": peak,
  };
}

function isAmount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function efficiency(capture, roots, rootIds) {
  const rootEvents = roots.flatMap(({ events }) => events);
  const turns = selectEvents(rootEvents, "turn.started").length;
  const steps = selectEvents(rootEvents, "step.started").length;
  const toolCalls = new Set();
  for (const [index, { events }] of roots.entries()) {
    for (const event of selectEvents(events, "actions.requested")) {
      for (const action of event.data?.actions ?? []) {
        if (TOOL_ACTION_KINDS.has(action?.kind))
          toolCalls.add(`${rootIds[index]}\0${action.callId}`);
      }
    }
  }
  const ratio = (numerator, denominator, reason) =>
    denominator === 0 ? notApplicable(reason) : measured(numerator / denominator);
  const delegated = new Set(
    selectEvents(rootEvents, "agent.started").map((event) => event.data?.sessionId),
  );
  return {
    "counts.turns": measured(turns),
    "counts.steps": measured(steps),
    "counts.steps_per_turn": ratio(steps, turns, "no-turns"),
    "counts.tool_calls": measured(toolCalls.size),
    "counts.tool_calls_per_step": ratio(toolCalls.size, steps, "no-model-steps"),
    "counts.subagent_fan_out": measured(delegated.size),
    "counts.subagent_depth": measured(
      Math.max(...rootIds.map((id) => delegationDepth(capture, id))),
    ),
    "counts.compactions": measured(selectEvents(rootEvents, "compaction.completed").length),
    "counts.context_clears": measured(selectEvents(rootEvents, "context.cleared").length),
  };
}

/** Longest `agent.started` chain below a session; uncaptured children count as leaves. */
function delegationDepth(capture, sessionId, visiting = new Set()) {
  if (visiting.has(sessionId)) return 0;
  const events = capture.bySession.get(sessionId) ?? [];
  const children = new Set(selectEvents(events, "agent.started").map((e) => e.data?.sessionId));
  let depth = 0;
  visiting.add(sessionId);
  for (const child of children)
    depth = Math.max(depth, 1 + delegationDepth(capture, child, visiting));
  visiting.delete(sessionId);
  return depth;
}

function reliability(events) {
  const results = selectEvents(events, "action.result");
  const toolErrors = results.filter((event) => event.data?.status === "failed").length;
  return {
    "reliability.step_failures": measured(selectEvents(events, "step.failed").length),
    "reliability.turn_failures": measured(selectEvents(events, "turn.failed").length),
    "reliability.session_failures": measured(selectEvents(events, "session.failed").length),
    "reliability.tool_errors": measured(toolErrors),
    "reliability.tool_error_rate":
      results.length === 0
        ? notApplicable("no-action-results")
        : measured(toolErrors / results.length),
    "reliability.truncations": measured(
      selectEvents(events, "step.completed", { finishReason: "length" }).length,
    ),
  };
}

function failureCodes(events) {
  const counts = new Map();
  for (const event of events) {
    if (!FAILURE_EVENTS.includes(event.type)) continue;
    const key = `${event.type}\0${typeof event.data?.code === "string" ? event.data.code : "UNKNOWN"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, count]) => {
      const [type, code] = key.split("\0");
      return { type, code, count };
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.code.localeCompare(b.code));
}

/**
 * Every eval detail artifact under one `.eve/evals/<timestamp>` tree, sorted.
 * The record builder and this file's CLI share it, so they agree on which
 * artifacts exist.
 */
export function listEvalArtifacts(runDirectory) {
  const evalsDirectory = join(runDirectory, "evals");
  if (!existsSync(evalsDirectory)) return [];
  return readdirSync(evalsDirectory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

// `node scripts/eval-metrics/standard.mjs <.eve/evals/<timestamp>>` prints each
// eval's outcome and metrics, then per-metric coverage across the run.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runDirectory = process.argv[2];
  if (runDirectory === undefined) {
    console.error("Usage: node scripts/eval-metrics/standard.mjs <.eve/evals/<timestamp>>");
    process.exit(1);
  }
  const { classifyOutcome } = await import("./gaps.mjs");
  const coverage = new Map(Object.keys(STANDARD_METRICS).map((key) => [key, 0]));
  const artifacts = listEvalArtifacts(runDirectory);
  for (const path of artifacts) {
    const artifact = JSON.parse(readFileSync(path, "utf8"));
    const { metrics } = deriveAttemptMetrics(artifact);
    console.log(`${artifact.id}: ${JSON.stringify(classifyOutcome(artifact))}`);
    for (const [key, m] of Object.entries(metrics)) {
      if (m.status === "measured") coverage.set(key, coverage.get(key) + 1);
      console.log(`  ${key} ${m.status === "measured" ? m.value : `${m.status} (${m.reason})`}`);
    }
  }
  console.log(`\nCoverage over ${artifacts.length} evals:`);
  for (const [key, count] of coverage) console.log(`  ${key} ${count}/${artifacts.length}`);
}
