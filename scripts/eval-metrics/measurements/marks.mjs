// durable-harness's timing marks for one eve session, derived from its v27
// facts the way its eve adapter does (`EveTranslator`, packages/bench/src/eve.ts):
//
//   model.request      the step's first `model.started`: eve chose the model and
//                      the provider call begins
//   model.first_token  the step's first text, reasoning, or call-input delta
//                      (or its `call.requested`, when nothing streamed)
//   model.done         the step's first `call.requested` for a tool step; else
//                      its last output, written when `model.settled` arrives
//   tool.start / end   `call.requested` / the call's `call.settled`, or the
//                      `call.started` that handed it to a task
//   idle               `turn.settled`
//
// A step is a model run a turn owns (not a compaction's summary run). Each mark
// has a server time `t` and the event that carried it to the client (`via`).
// They differ only for a back-dated `model.done`, whose time is the step's last
// output but which arrives with `model.settled`. A progress record (a delta)
// has no server time of its own, so its time is its client arrival less the
// session's smallest delivery lag, which needs the eval's client clock.
import { hasOwnTime, selectEvents, timestamp, unavailable } from "./events.mjs";
import { indexSession } from "./session.mjs";

const FIRST_TOKEN = new Set(["content.delta", "call.input", "call.requested"]);
const STREAMED_KINDS = new Set(["text", "reasoning"]);

/**
 * @typedef {{ t: number, via: object }} Mark
 * @typedef {{ key: string, turnId: string, request: Mark, firstToken?: Mark, untimed: boolean, done?: Mark, outputs: object[] }} StepMarks
 *   `key` is the run id. `outputs` are the events a client shows: streamed text, or calls starting.
 *   `untimed`: the step streamed output it can't place in time, so it has no first token.
 * @typedef {{ callId: string, runId: string, turnId: string | undefined, start: Mark, end?: Mark }} ToolMarks
 * @typedef {{ turnId: string, started: Mark, deliveries: Set<string>, idle?: Mark, steps: StepMarks[], tools: ToolMarks[] }} TurnMarks
 *   `deliveries` are the deliveries that started the turn.
 * @typedef {{ status: "ready", turns: Map<string, TurnMarks>, carriers: object[] }} SessionMarks
 */

/**
 * @param {object[]} events one session's v27 events
 * @param {{ index?: ReturnType<typeof indexSession>, arrival?: (event: object) => number | undefined }} [options]
 *   `arrival` is an event's client arrival time, when the eval recorded a clock.
 * @returns {SessionMarks | { status: "unavailable", reason: string }}
 */
export function sessionMarks(events, { index = indexSession(events), arrival } = {}) {
  const mark = (event) => {
    const t = timestamp(event);
    return t === undefined ? undefined : { t, via: event };
  };
  const earliest = (a, b) => (a === undefined || b.t < a.t ? b : a);

  const turns = new Map();
  for (const event of selectEvents(events, "turn.started")) {
    const started = mark(event);
    if (started === undefined) return unavailable("missing-timestamp");
    const turnId = event.data?.turnId;
    if (typeof turnId !== "string") return unavailable("missing-turn-identity");
    if (turns.has(turnId)) return unavailable("ambiguous-turn");
    turns.set(turnId, {
      turnId,
      started,
      deliveries: index.deliveries.get(turnId) ?? new Set(),
      steps: [],
      tools: [],
    });
  }
  const requests = new Set();
  for (const event of selectEvents(events, "model.requested")) {
    if (requests.has(event.data?.runId)) return unavailable("ambiguous-step");
    requests.add(event.data?.runId);
  }

  const steps = new Map();
  for (const run of index.steps) {
    const request = mark(run.started);
    if (request === undefined) return unavailable("missing-timestamp");
    const completed = run.settled?.data?.outcome === "completed" ? mark(run.settled) : undefined;
    if (run.settled?.data?.outcome === "completed" && completed === undefined)
      return unavailable("missing-timestamp");
    steps.set(run.runId, { key: run.runId, turnId: run.turnId, request, completed, seen: [] });
  }

  const tools = [];
  for (const call of index.calls.values()) {
    const step = steps.get(call.runId);
    if (step === undefined) continue;
    const start = mark(call.requested);
    if (start === undefined) return unavailable("missing-timestamp");
    const endEvent = [call.taskStarted, call.settled]
      .filter((event) => event !== undefined)
      .reduce(
        (a, b) => ((timestamp(b) ?? Infinity) < (timestamp(a) ?? Infinity) ? b : a),
        undefined,
      );
    const end = endEvent === undefined ? undefined : mark(endEvent);
    if (endEvent !== undefined && end === undefined) return unavailable("missing-timestamp");
    tools.push({ callId: call.callId, runId: call.runId, turnId: step.turnId, start, end });
  }

  for (const event of events) {
    const isOutput =
      FIRST_TOKEN.has(event.type) ||
      (event.type === "content.completed" && event.data?.kind === "text");
    if (!isOutput) continue;
    const step = steps.get(index.runOf(event));
    if (step === undefined) continue;
    if (event.type === "content.delta" && !STREAMED_KINDS.has(partKind(index, event))) continue;
    if (hasOwnTime(event) && timestamp(event) === undefined)
      return unavailable("missing-timestamp");
    step.seen.push(event);
  }

  // Server time for deltas: client arrival less the smallest delivery lag of the
  // facts that carry marks, the same offset the client-clock overheads use.
  const own = [
    ...[...turns.values()].map((turn) => turn.started.via),
    ...selectEvents(events, "turn.settled"),
    ...[...steps.values()].flatMap((step) => [step.request.via, step.completed?.via]),
    ...tools.flatMap((tool) => [tool.start.via, tool.end?.via]),
  ].filter((event) => event !== undefined);
  const lags = arrival === undefined ? [] : own.map((event) => arrival(event) - timestamp(event));
  const finiteLags = lags.filter((lag) => Number.isFinite(lag));
  const offset = finiteLags.length === 0 ? undefined : Math.min(...finiteLags);
  // A delta was written after the commit before it (its `meta.at`) and before
  // the next one. Its arrival is mapped with the next commit's delivery lag, the
  // nearest it has, or the session's smallest when nothing followed it.
  const nextCommit = nextCommits(events);
  const timeOf = (event) => {
    if (hasOwnTime(event)) return timestamp(event);
    const at = arrival?.(event);
    if (!Number.isFinite(at)) return undefined;
    const next = nextCommit.get(event);
    const nextLag = next === undefined ? undefined : arrival(next) - timestamp(next);
    const lag = Number.isFinite(nextLag) ? nextLag : offset;
    if (lag === undefined) return undefined;
    const after = timestamp(event) ?? -Infinity;
    return Math.min(Math.max(at - lag, after), next === undefined ? Infinity : timestamp(next));
  };

  for (const step of steps.values()) {
    step.outputs = [];
    let first;
    let last;
    let requested;
    let firstUnknown = false;
    for (const event of step.seen) {
      const t = timeOf(event);
      if (FIRST_TOKEN.has(event.type)) {
        if (t === undefined) firstUnknown = true;
        else first = earliest(first, { t, via: event });
      }
      if (isVisibleOutput(event, index)) step.outputs.push(event);
      if (t !== undefined && (last === undefined || t > last.t)) last = { t, via: event };
      if (event.type === "call.requested" && t !== undefined)
        requested = earliest(requested, { t, via: event });
    }
    // A delta it can't place in time could be the first token, so the step has none.
    step.firstToken = firstUnknown ? undefined : first;
    step.untimed = firstUnknown;
    if (requested !== undefined) step.done = requested;
    else if (step.completed !== undefined)
      step.done = { t: last?.t ?? step.completed.t, via: step.completed.via };
    delete step.seen;
    turns.get(step.turnId)?.steps.push(step);
  }
  for (const turnEnd of selectEvents(events, "turn.settled")) {
    const at = mark(turnEnd);
    if (at === undefined) return unavailable("missing-timestamp");
    const turn = turns.get(turnEnd.data?.turnId);
    if (turn !== undefined) turn.idle = earliest(turn.idle, at);
  }
  for (const tool of tools) turns.get(tool.turnId)?.tools.push(tool);
  for (const turn of turns.values()) {
    turn.steps.sort((a, b) => a.request.t - b.request.t);
    turn.tools.sort((a, b) => a.start.t - b.start.t);
    for (const step of turn.steps) delete step.completed;
  }

  // Every event that carries a mark: the offset rule maps server time onto
  // the client clock with the smallest delivery lag any of them had.
  const carriers = [];
  for (const turn of turns.values()) {
    if (turn.idle !== undefined) carriers.push(turn.idle.via);
    for (const step of turn.steps)
      for (const m of [step.request, step.firstToken, step.done]) if (m) carriers.push(m.via);
    for (const tool of turn.tools)
      for (const m of [tool.start, tool.end]) if (m) carriers.push(m.via);
  }
  return { status: "ready", turns, carriers: [...new Set(carriers)], timeOf };
}

/** For each progress record, the first fact after it in its stream. */
function nextCommits(events) {
  const order = (event) => {
    const { line, index } = event.meta?.position ?? {};
    return Number.isInteger(line) && Number.isInteger(index) ? line * 1e6 + index : undefined;
  };
  const positioned = events
    .filter((event) => order(event) !== undefined)
    .sort((a, b) => order(a) - order(b));
  const next = new Map();
  let pending = [];
  for (const event of positioned) {
    if (!hasOwnTime(event)) {
      pending.push(event);
      continue;
    }
    if (timestamp(event) === undefined) continue;
    for (const record of pending) next.set(record, event);
    pending = [];
  }
  return next;
}

function partKind(index, event) {
  return index.parts.get(event.data?.partId)?.kind ?? event.data?.kind;
}

function isVisibleOutput(event, index) {
  if (event.type === "content.delta")
    return (
      partKind(index, event) === "text" &&
      typeof event.data?.delta === "string" &&
      event.data.delta.length > 0
    );
  return event.type === "call.requested";
}

/** Marks in durable-harness's flat `{ name, key, t }` form, for conformance checks. */
export function listMarks(marks) {
  const list = [];
  for (const turn of marks.turns.values()) {
    for (const step of turn.steps) {
      list.push({ name: "model.request", key: step.key, t: step.request.t });
      if (step.firstToken)
        list.push({ name: "model.first_token", key: step.key, t: step.firstToken.t });
      if (step.done) list.push({ name: "model.done", key: step.key, t: step.done.t });
    }
    for (const tool of turn.tools) {
      list.push({ name: "tool.start", key: tool.callId, t: tool.start.t });
      if (tool.end) list.push({ name: "tool.end", key: tool.callId, t: tool.end.t });
    }
    if (turn.idle) list.push({ name: "idle", key: null, t: turn.idle.t });
  }
  return list;
}

/**
 * A turn's tool calls, grouped by the model step that requested them. Calls
 * keep the turn's start order, so a batch's first call started first.
 */
export function toolBatches(turn) {
  const batches = new Map();
  for (const tool of turn.tools) {
    const batch = batches.get(tool.runId) ?? [];
    batch.push(tool);
    batches.set(tool.runId, batch);
  }
  return [...batches.values()];
}

/** When the work just before a batch of tools ended: the step that asked for it, or an earlier tool. */
export function hopStart(turn, batch) {
  const ends = [
    ...turn.steps.map((step) => step.done?.t),
    ...turn.tools.filter((other) => !batch.includes(other)).map((other) => other.end?.t),
  ].filter((t) => t !== undefined && t <= batch[0].start.t);
  return ends.length === 0 ? undefined : Math.max(...ends);
}
