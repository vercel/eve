// Standard per-attempt metric set derived from one eval detail artifact
// (`.eve/evals/<ts>/evals/<id>.json`). STANDARD_METRICS below lists every
// metric with its unit and better direction.
//
// Scope: latency, attribution, cost, tokens, and efficiency counts read the
// eval's root sessions (sessions the eval opened, not delegated children);
// delegated spend reaches them through rolled-up `usage`. Reliability counts
// read every captured session, because a failure anywhere matters.
//
// Attribution partitions root turn time with a fixed precedence, so the parts
// add up to the turn total: human wait, then task (delegated work, including
// time a `task_wait` call blocks on it), tool (any other requested action),
// compaction, model step, and the remainder is framework time. In-process
// tools run inside their model step, so precedence keeps model ms to model work.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureSessions,
  notApplicable,
  selectEvents,
  timestamp,
  unavailable,
} from "./measurements/events.mjs";
import {
  coveredLengthBetween,
  firstDeltaInStep,
  pairIntervals,
  stepKey,
} from "./measurements/intervals.mjs";
import { completedTurns } from "./measurements/lifecycle.mjs";

/** Bump whenever a definition below changes meaning. */
export const METRICS_VERSION = 1;

/** Every metric in the standard set, with its unit and better direction. */
export const STANDARD_METRICS = Object.freeze({
  "latency.eval_wall_ms": { unit: "ms", direction: "lower" },
  "latency.turn_ms": { unit: "ms", direction: "lower" },
  "latency.turn_ms_mean": { unit: "ms", direction: "lower" },
  "latency.ttft_ms_p50": { unit: "ms", direction: "lower" },
  "latency.output_tokens_per_s": { unit: "tokens/s", direction: "higher" },
  "attribution.model_ms": { unit: "ms", direction: "lower" },
  "attribution.tool_ms": { unit: "ms", direction: "lower" },
  "attribution.task_ms": { unit: "ms", direction: "lower" },
  "attribution.human_wait_ms": { unit: "ms", direction: "neutral" },
  "attribution.compaction_ms": { unit: "ms", direction: "lower" },
  "attribution.framework_ms": { unit: "ms", direction: "lower" },
  "cost.total_usd": { unit: "usd", direction: "lower" },
  "cost.primary_usd": { unit: "usd", direction: "lower" },
  "cost.subagent_usd": { unit: "usd", direction: "lower" },
  "tokens.input": { unit: "tokens", direction: "lower" },
  "tokens.output": { unit: "tokens", direction: "lower" },
  "tokens.cache_read": { unit: "tokens", direction: "neutral" },
  "tokens.cache_write": { unit: "tokens", direction: "neutral" },
  "tokens.cache_hit_ratio": { unit: "ratio", direction: "higher" },
  "tokens.peak_context": { unit: "tokens", direction: "lower" },
  "counts.turns": { unit: "count", direction: "neutral" },
  "counts.steps": { unit: "count", direction: "lower" },
  "counts.steps_per_turn": { unit: "ratio", direction: "lower" },
  "counts.tool_calls": { unit: "count", direction: "neutral" },
  "counts.tool_calls_per_step": { unit: "ratio", direction: "neutral" },
  "counts.subagent_fan_out": { unit: "count", direction: "neutral" },
  "counts.subagent_depth": { unit: "count", direction: "neutral" },
  "counts.compactions": { unit: "count", direction: "lower" },
  "counts.context_clears": { unit: "count", direction: "neutral" },
  "reliability.step_failures": { unit: "count", direction: "lower" },
  "reliability.turn_failures": { unit: "count", direction: "lower" },
  "reliability.session_failures": { unit: "count", direction: "lower" },
  "reliability.tool_errors": { unit: "count", direction: "lower" },
  "reliability.tool_error_rate": { unit: "ratio", direction: "lower" },
  "reliability.truncations": { unit: "count", direction: "lower" },
});

const TURN_TERMINALS = ["turn.completed", "turn.failed", "turn.cancelled"];
const USAGE_EVENTS = ["session.waiting", "turn.waiting", "session.completed", "session.failed"];
const FAILURE_EVENTS = ["step.failed", "turn.failed", "session.failed"];
const TOOL_ACTION_KINDS = new Set(["tool-call", "workflow-tool-call"]);

/**
 * @param {object} evalArtifact parsed eval detail JSON
 * @returns {{
 *   metrics_version: number,
 *   metrics: Record<string, import("./measurements/events.mjs").Measurement>,
 *   failures: { type: string, code: string, count: number }[],
 * }}
 */
export function deriveAttemptMetrics(evalArtifact) {
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
  const roots = rootIds.map((sessionId) => ({
    events: capture.bySession.get(sessionId),
    timeline: sessionTimeline(capture, sessionId),
  }));
  const allEvents = capture.events;

  const metrics = {
    ...latencyAndAttribution(evalArtifact, roots),
    ...streaming(roots),
    ...costAndTokens(roots),
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
function sessionTimeline(capture, sessionId) {
  const events = capture.bySession.get(sessionId);
  const turns = completedTurns(capture, [sessionId], { terminalTypes: TURN_TERMINALS });
  const terminals = new Map(
    turns.status === "ready" ? turns.turns.map((t) => [t.start.data.turnId, t.completed]) : [],
  );
  // Work a turn abandons (a cancelled turn, a step cut off by a session
  // limit) ends with that turn.
  const closeOpen = (start) => terminals.get(start.data?.turnId);

  const steps = pairIntervals(
    selectEvents(events, "step.started"),
    [...selectEvents(events, "step.completed"), ...selectEvents(events, "step.failed")],
    { startKeys: (e) => [stepKey(e)], endKeys: (e) => [stepKey(e)], subject: "step", closeOpen },
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
    turns:
      turns.status === "ready"
        ? toIntervals(turns.turns.map((t) => ({ start: t.start, end: t.completed })))
        : turns,
    steps,
    actions,
    tasks,
    compactions,
    human: humanWait(events, closeOpen),
  };
}

function taskIdentity(event) {
  const { taskId, callId } = event.data ?? {};
  return typeof taskId === "string" && typeof callId === "string"
    ? `${taskId}/${callId}`
    : undefined;
}

function toIntervals(pairs) {
  const intervals = [];
  for (const { start, end } of pairs) {
    const startAt = timestamp(start);
    const endAt = timestamp(end);
    if (startAt === undefined || endAt === undefined) return unavailable("missing-timestamp");
    if (endAt < startAt) return unavailable("negative-duration");
    intervals.push({ start, end, startAt, endAt });
  }
  return { status: "ready", intervals };
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

function streaming(roots) {
  const ttfts = [];
  let tokens = 0;
  let streamMs = 0;
  let missingTokens = false;
  for (const { events } of roots) {
    const completions = new Map(
      selectEvents(events, "step.completed").map((event) => [stepKey(event), event]),
    );
    for (const [key, { start, firstDelta }] of firstDeltaInStep(events)) {
      const startAt = timestamp(start);
      if (firstDelta === undefined || startAt === undefined) continue;
      const deltaAt = timestamp(firstDelta);
      ttfts.push(deltaAt - startAt);
      const completed = completions.get(key);
      if (completed === undefined) continue;
      const outputTokens = completed.data?.usage?.outputTokens;
      if (typeof outputTokens !== "number") missingTokens = true;
      else tokens += outputTokens;
      streamMs += (timestamp(completed) ?? deltaAt) - deltaAt;
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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function costAndTokens(roots) {
  const steps = roots.flatMap(({ events }) => selectEvents(events, "step.completed"));
  const rollups = roots.map(({ events }) => latestUsage(events));

  let primary;
  if (steps.length === 0) primary = notApplicable("no-model-steps");
  else if (steps.some((step) => !isAmount(step.data?.usage?.costUsd)))
    primary = unavailable("missing-step-cost");
  else primary = measured(steps.reduce((total, step) => total + step.data.usage.costUsd, 0));

  const rolled = (field, reason) =>
    rollups.some((usage) => !isAmount(usage?.[field]))
      ? unavailable(reason)
      : measured(rollups.reduce((total, usage) => total + usage[field], 0));
  const total = rolled("costUsd", "missing-rolled-up-cost");

  let subagent;
  if (total.status !== "measured") subagent = total;
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

/** The session's latest rolled-up usage, which includes delegated spend. */
function latestUsage(events) {
  let latest;
  for (const event of events) {
    if (!USAGE_EVENTS.includes(event.type) || event.data?.usage === undefined) continue;
    if (latest === undefined || (timestamp(event) ?? -Infinity) >= (timestamp(latest) ?? -Infinity))
      latest = event;
  }
  return latest?.data.usage;
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
    "counts.compactions": measured(selectEvents(capture.events, "compaction.completed").length),
    "counts.context_clears": measured(selectEvents(capture.events, "context.cleared").length),
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

/** Find every eval detail artifact under one `.eve/evals/<timestamp>` tree. */
export function listEvalArtifacts(runDirectory) {
  const evalsDirectory = join(runDirectory, "evals");
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".json")) files.push(path);
    }
  };
  if (existsSync(evalsDirectory)) visit(evalsDirectory);
  return files.sort();
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
