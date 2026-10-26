// durable-harness's timing marks for one eve session, derived from its events
// the way its eve adapter does (`EveTranslator`, packages/bench/src/eve.ts):
//
//   model.request      `step.started`
//   model.first_token  the step's first text, reasoning, or tool-input delta
//                      (or its `actions.requested`, when nothing streamed)
//   model.done         `actions.requested` for a tool step; else the step's
//                      last output, written when `step.completed` arrives
//   tool.start / end   `actions.requested` / `action.result`, by call id
//   idle               `turn.completed` / `turn.failed` / `turn.cancelled`
//
// Each mark has a server time `t` (`meta.at`) and the event that carried it
// to the client (`via`). They differ only for a back-dated `model.done`,
// whose time is the step's last output but which arrives with `step.completed`.
// Steps are keyed by turn and step index, not stream position, so repeated
// captures of a session merge cleanly.
import { selectEvents, timestamp, unavailable } from "./events.mjs";
import { stepKey } from "./intervals.mjs";

const FIRST_TOKEN = new Set([
  "message.appended",
  "reasoning.appended",
  "action.input.appended",
  "actions.requested",
]);
const OUTPUT = new Set([...FIRST_TOKEN, "message.completed"]);
const IDLE = new Set(["turn.completed", "turn.failed", "turn.cancelled"]);

/**
 * @typedef {{ t: number, via: object }} Mark
 * @typedef {{ key: string, turnId: string, request: Mark, firstToken?: Mark, done?: Mark, outputs: object[] }} StepMarks
 *   `outputs` are the events a client shows: streamed text, or tools starting.
 * @typedef {{ callId: string, turnId: string | undefined, start: Mark, end?: Mark }} ToolMarks
 * @typedef {{ turnId: string, started: Mark, idle?: Mark, steps: StepMarks[], tools: ToolMarks[] }} TurnMarks
 * @typedef {{ status: "ready", turns: Map<string, TurnMarks>, carriers: object[] }} SessionMarks
 */

/**
 * @param {object[]} events one session's events, in capture order
 * @returns {SessionMarks | { status: "unavailable", reason: string }}
 */
export function sessionMarks(events) {
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
    turns.set(turnId, { turnId, started, steps: [], tools: [] });
  }

  const steps = new Map();
  const seenByStep = new Map();
  const tools = new Map();
  const later = [];
  for (const event of events) {
    const relevant =
      event.type === "step.started" ||
      event.type === "step.completed" ||
      event.type === "action.result" ||
      OUTPUT.has(event.type) ||
      IDLE.has(event.type);
    if (!relevant) continue;
    const at = mark(event);
    if (at === undefined) return unavailable("missing-timestamp");
    if (event.type === "action.result" || IDLE.has(event.type)) {
      later.push(at);
      continue;
    }
    const key = stepKey(event);
    if (event.type === "step.started") {
      if (key === undefined) return unavailable("missing-step-identity");
      if (steps.has(key)) return unavailable("ambiguous-step");
      steps.set(key, { key, turnId: event.data.turnId, request: at });
      continue;
    }
    if (key === undefined) continue;
    const seen = seenByStep.get(key) ?? { outputs: [] };
    seenByStep.set(key, seen);
    if (event.type === "step.completed") {
      seen.completed = earliest(seen.completed, at);
      continue;
    }
    if (FIRST_TOKEN.has(event.type)) seen.first = earliest(seen.first, at);
    if (isVisibleOutput(event)) seen.outputs.push(event);
    if (seen.last === undefined || at.t > seen.last.t) seen.last = at;
    if (event.type !== "actions.requested") continue;
    seen.requested = earliest(seen.requested, at);
    for (const action of Array.isArray(event.data?.actions) ? event.data.actions : []) {
      const callId = action?.callId;
      if (typeof callId === "string" && !tools.has(callId))
        tools.set(callId, { callId, turnId: event.data?.turnId, start: at });
    }
  }
  // Ends pair with starts by identity, whatever order the captures merged in.
  for (const at of later) {
    if (at.via.type === "action.result") {
      const tool = tools.get(at.via.data?.result?.callId);
      if (tool !== undefined) tool.end = earliest(tool.end, at);
    } else {
      const turn = turns.get(at.via.data?.turnId);
      if (turn !== undefined) turn.idle = earliest(turn.idle, at);
    }
  }

  for (const step of steps.values()) {
    const seen = seenByStep.get(step.key);
    step.outputs = seen?.outputs ?? [];
    step.firstToken = seen?.first;
    if (seen?.requested !== undefined) step.done = seen.requested;
    else if (seen?.completed !== undefined)
      step.done = { t: seen.last?.t ?? seen.completed.t, via: seen.completed.via };
    turns.get(step.turnId)?.steps.push(step);
  }
  for (const tool of tools.values()) turns.get(tool.turnId)?.tools.push(tool);
  for (const turn of turns.values()) {
    turn.steps.sort((a, b) => a.request.t - b.request.t);
    turn.tools.sort((a, b) => a.start.t - b.start.t);
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
  return { status: "ready", turns, carriers: [...new Set(carriers)] };
}

function isVisibleOutput(event) {
  if (event.type === "message.appended")
    return typeof event.data?.messageDelta === "string" && event.data.messageDelta.length > 0;
  return (
    event.type === "actions.requested" &&
    Array.isArray(event.data?.actions) &&
    event.data.actions.length > 0
  );
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

/** When the work just before a tool ended: the step that asked for it, or an earlier tool. */
export function hopStart(turn, tool) {
  const ends = [
    ...turn.steps.map((step) => step.done?.t),
    ...turn.tools.filter((other) => other !== tool).map((other) => other.end?.t),
  ].filter((t) => t !== undefined && t <= tool.start.t);
  return ends.length === 0 ? undefined : Math.max(...ends);
}
