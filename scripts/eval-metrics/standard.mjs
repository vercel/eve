// Standard per-attempt metric set derived from one eval detail artifact
// (`.eve/evals/<ts>/evals/<id>.json`). STANDARD_METRICS below lists every
// metric with its unit and better direction. Sessions are read as v27 facts
// (eve 0.84.0 and later); measurements/legacy.mjs upgrades older captures.
//
// A model step is a model run a turn owns: a compaction's summary run is not
// one. A call's own time runs from `call.requested` to its `call.settled`, or
// to the `call.started` that hands it to a task; from there it is task time.
//
// Scope: latency, attribution, peak context, and efficiency counts read the
// eval's root sessions (sessions the eval opened, not delegated children).
// Reliability counts read every captured session, because a failure anywhere
// matters.
//
// Cost and tokens: `cost.total_usd` and `tokens.*` (but `tokens.peak_context`)
// are the runner's `result.derived.usage`, the same totals the eval reporters
// see: each captured session's latest usage, including delegated work and
// compaction summaries, less sessions another captured session opened.
//
// Attribution partitions root turn time with a fixed precedence, so the parts
// add up to the turn total: human wait, then task (delegated work, including
// time a `task_wait` call blocks on it), tool (any other call), compaction,
// model step, and the remainder is framework time. Human wait is every
// interaction a person was asked, until it settled (an invalid answer leaves it
// open). A model step ends at durable-harness's `model.done` mark (its call
// requested, or its last output), not at `model.settled`: recording a finished
// response is framework time, as it is on /compare.
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
  UnsupportedCaptureError,
  captureSessions,
  eventKey,
  notApplicable,
  selectEvents,
  unavailable,
} from "./measurements/events.mjs";
import { clientOverheads, durability, median, readClock, serverOverheads } from "./framework.mjs";
import { coveredLengthBetween, pairIntervals } from "./measurements/intervals.mjs";
import { sessionMarks } from "./measurements/marks.mjs";
import { indexSession, sessionFailures } from "./measurements/session.mjs";

/** Bump whenever a definition below changes meaning. */
export const METRICS_VERSION = 4;

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
    "overhead.pre_model_ms": "compaction time excluded",
    "overhead.first_output_ms": "compaction time excluded",
    "overhead.turn_ms": "concurrent tool time counts once; compaction time excluded",
    "overhead.tool_hop_ms":
      "one sample per batch of calls a model step requested; compaction time excluded",
    "overhead.tool_call_ms":
      "one sample per batch of calls a model step requested; compaction time excluded",
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
  "latency.ttft_ms_p50": model("ms", "lower"),
  "attribution.model_ms": model("ms", "lower"),
  "attribution.tool_ms": model("ms", "lower"),
  "attribution.task_ms": model("ms", "lower"),
  "attribution.human_wait_ms": model("ms", "neutral"),
  "attribution.compaction_ms": model("ms", "lower"),
  "attribution.framework_ms": framework("ms", "lower", { pooled: false }),
  "overhead.pre_model_ms": framework("ms", "lower", { per: "turn", pooled: true }),
  "overhead.model_start_ms": framework("ms", "lower", { per: "step", pooled: true }),
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
  "tokens.input": model("tokens", "lower"),
  "tokens.output": model("tokens", "lower"),
  "tokens.cache_hit_ratio": model("ratio", "higher"),
  "tokens.peak_context": model("tokens", "lower"),
  "counts.steps": model("count", "lower"),
  "counts.tool_calls": model("count", "neutral"),
  "counts.compactions": model("count", "lower"),
  "reliability.turn_failures": model("count", "lower"),
  "reliability.session_failures": model("count", "lower"),
  "reliability.truncations": model("count", "lower"),
});

const TOOL_CAPABILITIES = new Set(["tool", "control"]);

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
  const sessions = Array.isArray(evalArtifact?.result?.sessions)
    ? evalArtifact.result.sessions.filter((session) => typeof session?.sessionId === "string")
    : undefined;
  let capture;
  try {
    capture = captureSessions(sessions);
  } catch (error) {
    return everyMetric(
      unavailable(
        error instanceof UnsupportedCaptureError ? error.reason : "invalid-session-capture",
      ),
    );
  }
  if (capture === undefined) return everyMetric(unavailable("missing-session-capture"));
  if (capture.bySession.size === 0) return everyMetric(notApplicable("no-sessions"));

  const indexes = new Map(
    [...capture.bySession].map(([sessionId, events]) => [sessionId, indexSession(events)]),
  );
  const rootIds = rootSessionIds(capture, indexes);
  if (rootIds.length === 0) return everyMetric(unavailable("missing-root-session"));
  const clock = readClock(sessions);
  const roots = rootIds.map((sessionId) => {
    const events = capture.bySession.get(sessionId);
    const index = indexes.get(sessionId);
    const arrival =
      clock === undefined ? undefined : (event) => clock.arrivals.get(eventKey(sessionId, event));
    const marks = sessionMarks(events, { index, arrival });
    return { sessionId, events, index, marks, timeline: sessionTimeline(events, index, marks) };
  });

  const metrics = {
    ...latencyAndAttribution(evalArtifact, roots),
    ...serverOverheads(roots, capture.bySession),
    ...clientOverheads(clock, roots),
    ...durability(roots, world),
    ...streaming(roots),
    ...costAndTokens(evalArtifact, roots),
    ...efficiency(roots),
    ...reliability(capture, indexes),
  };
  return { metrics_version: METRICS_VERSION, metrics, failures: failureCodes(capture, indexes) };
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

/** Sessions the eval opened itself: none of the captured sessions opened them. */
function rootSessionIds(capture, indexes) {
  const children = new Set(
    [...indexes.values()].flatMap((index) => index.children.map((child) => child.sessionId)),
  );
  for (const [sessionId, events] of capture.bySession) {
    if (selectEvents(events, "session.started").some((e) => e.data?.parent !== undefined))
      children.add(sessionId);
  }
  return [...capture.bySession.keys()].filter((sessionId) => !children.has(sessionId));
}

/** Pair every interval family of one session, clipping nothing yet. */
function sessionTimeline(events, index, marks) {
  const turnStarts = selectEvents(events, "turn.started");
  const byTurn = (e) => [e.data?.turnId];
  // A root session with no turns has no turn time to attribute; without this,
  // every latency and attribution part would read as a measured zero.
  const turns =
    turnStarts.length === 0
      ? unavailable("missing-turn")
      : pairIntervals(turnStarts, selectEvents(events, "turn.settled"), {
          startKeys: byTurn,
          endKeys: byTurn,
          subject: "turn",
        });
  const terminals = new Map(
    turns.status === "ready" ? turns.intervals.map((turn) => [turn.key, turn.end]) : [],
  );
  // Work a turn abandons (a cancelled turn, a step cut off by a session
  // limit) ends with that turn.
  const closeOpen = (start) => terminals.get(index.turnOf(start));

  const byRun = (e) => [e.data?.runId];
  const steps = endStepsAtModelDone(
    pairIntervals(
      index.steps.map((run) => run.started),
      index.steps.flatMap((run) => (run.settled === undefined ? [] : [run.settled])),
      { startKeys: byRun, endKeys: byRun, subject: "step", closeOpen },
    ),
    marks,
  );

  // A call's own work ends when it settles, or when it hands off to a task,
  // whose work is delegated time (`tasks`) instead.
  const byCall = (e) => [e.data?.callId];
  const calls = [...index.calls.values()];
  const actions = pairIntervals(
    selectEvents(events, "call.requested"),
    [
      ...calls.flatMap((call) => (call.end === undefined ? [] : [call.end])),
      ...selectEvents(events, "call.settled").filter((e) => !index.calls.has(e.data?.callId)),
    ],
    {
      startKeys: byCall,
      endKeys: byCall,
      subject: "action",
      repeatedStarts: "earliest",
      closeOpen,
    },
  );
  const tasked = calls.filter((call) => call.taskStarted !== undefined);
  const tasks = pairIntervals(
    tasked.map((call) => call.taskStarted),
    tasked.flatMap((call) => (call.settled === undefined ? [] : [call.settled])),
    { startKeys: byCall, endKeys: byCall, subject: "task", closeOpen },
  );
  const byChange = (e) => [e.data?.changeId];
  const compactions = pairIntervals(
    selectEvents(events, "context.started", { kind: "compaction" }),
    selectEvents(events, "context.settled", { kind: "compaction" }),
    { startKeys: byChange, endKeys: byChange, subject: "compaction", closeOpen },
  );
  // A person was asked something (an approval, an answer, a sign-in, more
  // budget) until it settled; an invalid answer leaves the question open.
  const byInteraction = (e) => [e.data?.interactionId];
  const human = pairIntervals(
    selectEvents(events, "interaction.opened"),
    selectEvents(events, "interaction.settled").filter((e) => e.data?.outcome !== "invalid"),
    {
      startKeys: byInteraction,
      endKeys: byInteraction,
      subject: "interaction",
      repeatedStarts: "earliest",
      closeOpen,
    },
  );
  return { turns, steps, actions, tasks, compactions, human };
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
    humanIntervals.push(...H);
  }

  const sum = (values) => (failure ? failure : measured(values.reduce((a, b) => a + b, 0)));
  return {
    "latency.eval_wall_ms": failure ?? evalWall(evalArtifact, humanIntervals),
    "latency.turn_ms": sum(parts.turn),
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

/** Median time to first token over model steps, from their marks. */
function streaming(roots) {
  const broken = roots.find(({ marks }) => marks.status !== "ready");
  if (broken !== undefined) return { "latency.ttft_ms_p50": broken.marks };
  const ttfts = [];
  for (const { marks } of roots) {
    for (const turn of marks.turns.values()) {
      for (const step of turn.steps) {
        // A step whose first token can't be placed would leave the median biased.
        if (step.untimed) return { "latency.ttft_ms_p50": unavailable("untimed-first-token") };
        if (step.firstToken !== undefined) ttfts.push(step.firstToken.t - step.request.t);
      }
    }
  }
  return {
    "latency.ttft_ms_p50":
      ttfts.length === 0 ? notApplicable("no-streamed-steps") : measured(median(ttfts)),
  };
}

/** A run's `usage.recorded` total for one field, or undefined when it recorded none or no such amount. */
function usageOf(run, field) {
  if (run.usage.length === 0) return undefined;
  let total = 0;
  for (const record of run.usage) {
    const value = record.data?.usage?.[field];
    if (!isAmount(value)) return undefined;
    total += value;
  }
  return total;
}

function costAndTokens(evalArtifact, roots) {
  const steps = roots.flatMap(({ index }) =>
    index.steps.filter((run) => run.settled?.data?.outcome === "completed"),
  );
  // Absent when a counted session reported no usage; `costUsd` is absent when
  // one reported no cost (eve's evalUsage).
  const usage = evalArtifact?.result?.derived?.usage;
  const rolled = (field, reason) =>
    isAmount(usage?.[field]) ? measured(usage[field]) : unavailable(reason);

  const input = rolled("inputTokens", "missing-rolled-up-usage");
  const cacheRead = rolled("cacheReadTokens", "missing-rolled-up-usage");
  let cacheHitRatio;
  if (input.status !== "measured") cacheHitRatio = input;
  else if (cacheRead.status !== "measured") cacheHitRatio = cacheRead;
  else if (input.value === 0) cacheHitRatio = notApplicable("no-input-tokens");
  else cacheHitRatio = measured(cacheRead.value / input.value);

  let peak;
  if (steps.length === 0) peak = notApplicable("no-model-steps");
  else if (steps.some((run) => usageOf(run, "inputTokens") === undefined))
    peak = unavailable("missing-step-input-tokens");
  else peak = measured(Math.max(...steps.map((run) => usageOf(run, "inputTokens"))));

  return {
    "cost.total_usd": rolled("costUsd", "missing-rolled-up-cost"),
    "tokens.input": input,
    "tokens.output": rolled("outputTokens", "missing-rolled-up-usage"),
    "tokens.cache_hit_ratio": cacheHitRatio,
    "tokens.peak_context": peak,
  };
}

function isAmount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function efficiency(roots) {
  const rootEvents = roots.flatMap(({ events }) => events);
  const steps = roots.reduce((total, { index }) => total + index.steps.length, 0);
  const toolCalls = roots.reduce(
    (total, { index }) =>
      total +
      [...index.calls.values()].filter((call) => TOOL_CAPABILITIES.has(call.capability?.kind))
        .length,
    0,
  );
  const compactions = selectEvents(rootEvents, "context.settled", {
    kind: "compaction",
    outcome: "completed",
  }).length;
  return {
    "counts.steps": measured(steps),
    "counts.tool_calls": measured(toolCalls),
    "counts.compactions": measured(compactions),
  };
}

/** Every captured session's failures, since a failure anywhere matters. */
function allFailures(capture, indexes) {
  return [...capture.bySession].flatMap(([sessionId, events]) =>
    sessionFailures(events, indexes.get(sessionId)),
  );
}

function reliability(capture, indexes) {
  const failures = allFailures(capture, indexes);
  const count = (type) => failures.filter((failure) => failure.type === type).length;
  const truncations = [...indexes.values()]
    .flatMap((index) => index.steps)
    .filter((run) => run.settled?.data?.finishReason === "length").length;
  return {
    "reliability.turn_failures": measured(count("turn.failed")),
    "reliability.session_failures": measured(count("session.failed")),
    "reliability.truncations": measured(truncations),
  };
}

function failureCodes(capture, indexes) {
  const counts = new Map();
  for (const { type, error } of allFailures(capture, indexes)) {
    const key = `${type}\0${typeof error.code === "string" ? error.code : "UNKNOWN"}`;
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
