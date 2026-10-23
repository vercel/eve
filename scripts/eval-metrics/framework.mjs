// Framework overhead: the time and durable work in an eval attempt that is
// neither the model nor the tools. Definitions follow durable-harness's
// /compare page (packages/demo-ui/src/compare-glossary.ts at
// METRIC_DEFINITIONS.commit in standard.mjs), so a value here means what the
// same name means there. fixtures/durable-harness/ holds the conformance data.
//
// Per-occurrence metrics (per turn, per call, per send) are the attempt's p50,
// with `count` and the raw `samples` so quantiles can be recomputed across
// attempts. An occurrence the definition does not cover (a tool that ended
// its turn has no next model call) is left out, never estimated.
import { notApplicable, selectEvents, timestamp, unavailable } from "./measurements/events.mjs";
import { hopStart } from "./measurements/marks.mjs";

/**
 * Server-clock parts, from the root sessions' marks.
 *
 * @param {{ sessionId: string, marks: ReturnType<typeof import("./measurements/marks.mjs").sessionMarks> }[]} roots
 * @param {Map<string, object[]>} bySession every captured session's events
 */
export function serverOverheads(roots, bySession) {
  const broken = roots.find(({ marks }) => marks.status !== "ready");
  if (broken !== undefined) {
    return Object.fromEntries(
      ["pre_model_ms", "tool_hop_ms", "finalize_ms", "agent_start_ms"].map((name) => [
        `overhead.${name}`,
        broken.marks,
      ]),
    );
  }
  const preModel = [];
  const toolHop = [];
  const finalize = [];
  const agentStart = [];
  let missingChild = false;
  for (const { sessionId, marks } of roots) {
    for (const turn of marks.turns.values()) {
      const [first] = turn.steps;
      if (first !== undefined) preModel.push(first.request.t - turn.started.t);

      // A tool that ends its turn finishes the turn's work, so finalization
      // starts at the later of the last model.done and the last tool.end.
      const workEnds = [
        ...turn.steps.map((step) => step.done?.t),
        ...turn.tools.map((tool) => tool.end?.t),
      ].filter((t) => t !== undefined);
      if (turn.idle !== undefined && workEnds.length > 0)
        finalize.push(turn.idle.t - Math.max(...workEnds));

      for (const tool of turn.tools) {
        if (tool.end === undefined) continue;
        const hop = hopStart(turn, tool);
        const next = turn.steps.find((step) => step.request.t >= tool.end.t);
        if (hop === undefined || next === undefined) continue;
        toolHop.push(next.request.t - hop - (tool.end.t - tool.start.t));
      }
    }

    const toolStarts = new Map(
      [...marks.turns.values()].flatMap((turn) => turn.tools.map((tool) => [tool.callId, tool])),
    );
    const events = bySession.get(sessionId) ?? [];
    for (const started of selectEvents(events, "agent.started")) {
      const call = toolStarts.get(started.data?.callId);
      const child = bySession.get(started.data?.sessionId);
      if (call === undefined) continue;
      if (child === undefined) {
        missingChild = true;
        continue;
      }
      const childStarts = selectEvents(child, "turn.started")
        .map(timestamp)
        .filter((t) => t !== undefined);
      if (childStarts.length === 0) missingChild = true;
      else agentStart.push(Math.min(...childStarts) - call.start.t);
    }
  }
  return {
    "overhead.pre_model_ms": perOccurrence(preModel, "no-model-steps"),
    "overhead.tool_hop_ms": perOccurrence(toolHop, "no-tool-hops"),
    "overhead.finalize_ms": perOccurrence(finalize, "no-finished-turns"),
    "overhead.agent_start_ms":
      agentStart.length === 0 && missingChild
        ? unavailable("missing-child-session")
        : perOccurrence(agentStart, "no-agent-starts"),
  };
}

const CLIENT_METRICS = [
  "overhead.first_output_ms",
  "overhead.turn_ms",
  "overhead.tool_call_ms",
  "session.not_ready_ms",
  "session.create_ms",
];

/**
 * Headline metrics on the eval client's clock, as /compare measures them from
 * the page. `sent` is the accepted attempt of a send; time spent retrying
 * `409 session_not_ready` before it is `session.not_ready_ms` and in no other
 * number. A session created with its first message has no prewarm, so that
 * turn's numbers include creating it. Server times map onto the client clock
 * with the smallest delivery lag (`arrival − meta.at`) the session's marks had.
 *
 * @param {object[]} sessionEntries the artifact's raw `result.sessions`
 * @param {{ sessionId: string, marks: object }[]} roots
 */
export function clientOverheads(sessionEntries, roots) {
  const clock = readClock(sessionEntries);
  if (clock === undefined) return everyClientMetric(unavailable("missing-client-clock"));
  const broken = roots.find(({ marks }) => marks.status !== "ready");
  if (broken !== undefined) return everyClientMetric(broken.marks);

  const firstOutput = [];
  const turnOverhead = [];
  const toolCall = [];
  const notReady = [];
  const create = [];
  for (const { sessionId, marks } of roots) {
    const sends = clock.sends.get(sessionId) ?? [];
    for (const send of sends) {
      if (send.kind === "prewarm" || send.kind === "create")
        create.push(send.acceptedAt - send.startedAt);
      if (send.kind === "message") notReady.push(send.notReadyMs);
    }
    const arrival = (event) => clock.arrivals.get(event.meta.id);
    const lags = marks.carriers
      .map((event) => arrival(event) - timestamp(event))
      .filter((lag) => Number.isFinite(lag));
    if (lags.length === 0) continue;
    const offset = Math.min(...lags);

    const turns = [...marks.turns.values()].sort((a, b) => a.started.t - b.started.t);
    for (const send of sends) {
      // A message starts the turn that carries its delivery (a steer joins a
      // running turn and starts none); a session created with a message
      // starts with that message's turn.
      const turn =
        send.kind === "create"
          ? turns[0]
          : send.kind === "message"
            ? turns.find((candidate) =>
                candidate.started.via.meta?.deliveryIds?.includes(send.deliveryId),
              )
            : undefined;
      if (turn === undefined) continue;
      const measuredTurn = measureTurn(turn, send.startedAt + send.notReadyMs, arrival, offset);
      if (measuredTurn === undefined) continue;
      if (measuredTurn.firstOutput !== undefined) firstOutput.push(measuredTurn.firstOutput);
      if (measuredTurn.turn !== undefined) turnOverhead.push(measuredTurn.turn);
      toolCall.push(...measuredTurn.tools);
    }
  }
  return {
    "overhead.first_output_ms": perOccurrence(firstOutput, "no-sent-turns"),
    "overhead.turn_ms": perOccurrence(turnOverhead, "no-sent-turns"),
    "overhead.tool_call_ms": perOccurrence(toolCall, "no-tool-hops"),
    "session.not_ready_ms": perOccurrence(notReady, "no-message-sends"),
    "session.create_ms": perOccurrence(create, "no-created-sessions"),
  };
}

function measureTurn(turn, sent, arrival, offset) {
  const idleAt = turn.idle === undefined ? undefined : arrival(turn.idle.via);
  const inWindow = (at) => at !== undefined && at >= sent && (idleAt === undefined || at <= idleAt);
  // Outputs as the client shows them: streamed text, or a tool starting.
  const outputs = [];
  for (const step of turn.steps) {
    for (const event of step.outputs ?? []) {
      const at = arrival(event);
      if (inWindow(at)) outputs.push({ at, event });
    }
  }
  outputs.sort((a, b) => a.at - b.at);
  const calls = turn.steps
    .map((step) => ({
      step,
      reqAt: arrival(step.request.via),
      doneAt: step.done && arrival(step.done.via),
    }))
    .filter(({ reqAt }) => inWindow(reqAt));
  // The model's own time to the output the client saw: to its first token,
  // or to its end when that output only appeared once it was done.
  const visibleModelMs = (call, outAt) => {
    if (call === undefined) return undefined;
    const { step, doneAt } = call;
    if (step.done !== undefined && doneAt !== undefined && doneAt <= outAt)
      return step.done.t - step.request.t;
    return step.firstToken === undefined ? undefined : step.firstToken.t - step.request.t;
  };

  const result = { tools: [] };
  const [firstOut] = outputs;
  if (firstOut !== undefined) {
    const before = calls.filter(({ reqAt }) => reqAt <= firstOut.at);
    const call =
      before
        .filter(({ step }) => step.firstToken !== undefined || step.done !== undefined)
        .at(-1) ?? before.at(-1);
    const modelMs = visibleModelMs(call, firstOut.at);
    if (modelMs !== undefined) result.firstOutput = firstOut.at - sent - modelMs;
  }

  if (idleAt !== undefined && calls.length > 0 && calls.every(({ step }) => step.done)) {
    const modelSum = calls.reduce((sum, { step }) => sum + step.done.t - step.request.t, 0);
    const toolSum = turn.tools
      .filter((tool) => inWindow(arrival(tool.start.via)))
      .reduce((sum, tool) => sum + (tool.end === undefined ? 0 : tool.end.t - tool.start.t), 0);
    result.turn = idleAt - sent - modelSum - toolSum;
  }

  for (const tool of turn.tools) {
    const startAt = arrival(tool.start.via);
    if (tool.end === undefined || !inWindow(startAt)) continue;
    // Calls requested together start together; the next output is the first
    // one after their request, so every call of a batch is measured.
    const nextOut = outputs.find(({ at, event }) => at >= startAt && event !== tool.start.via);
    if (nextOut === undefined) continue;
    const next =
      calls.find(({ step, reqAt }) => step.request.t >= tool.end.t && reqAt <= nextOut.at) ??
      calls.find(({ reqAt }) => reqAt >= startAt && reqAt <= nextOut.at);
    const nextModelMs = visibleModelMs(next, nextOut.at);
    if (nextModelMs === undefined) continue;
    const exec = tool.end.t - tool.start.t;
    const hop = hopStart(turn, tool);
    result.tools.push(
      hop === undefined
        ? nextOut.at - (tool.end.t + offset) - nextModelMs
        : nextOut.at - (hop + offset) - exec - nextModelMs,
    );
  }
  return result;
}

/**
 * Arrival time of every captured event (the earliest, across repeated
 * captures) and every session's sends, or undefined when the artifact
 * predates client timing.
 */
function readClock(sessionEntries) {
  const withClock = (sessionEntries ?? []).filter(
    (entry) =>
      Array.isArray(entry?.clock?.receivedAt) &&
      entry.clock.receivedAt.length === entry.events?.length,
  );
  if (withClock.length === 0) return undefined;
  const arrivals = new Map();
  const sends = new Map();
  for (const entry of withClock) {
    entry.events.forEach((event, index) => {
      const at = entry.clock.receivedAt[index];
      const id = event?.meta?.id;
      if (typeof id !== "string" || !Number.isFinite(at)) return;
      arrivals.set(id, Math.min(arrivals.get(id) ?? Infinity, at));
    });
    const valid = (entry.clock.sends ?? []).filter(
      (send) =>
        Number.isFinite(send?.startedAt) &&
        Number.isFinite(send?.acceptedAt) &&
        Number.isFinite(send?.notReadyMs),
    );
    sends.set(entry.sessionId, [...(sends.get(entry.sessionId) ?? []), ...valid]);
  }
  return { arrivals, sends };
}

function everyClientMetric(measurement) {
  return Object.fromEntries(CLIENT_METRICS.map((key) => [key, measurement]));
}

const DURABILITY_METRICS = [
  "durability.workflow_steps_per_turn",
  "durability.step_input_bytes_per_turn",
  "durability.step_output_bytes_per_turn",
  "durability.workflow_steps_per_model_step",
];

/**
 * Durable work from the world probe: the workflow event log of each root
 * session's run (a session id is its run id), exported by the run job with
 * each payload's stored size in place of the payload. A step whose payload
 * the world no longer holds (a purged run) makes the bytes unknown, not zero.
 * Every turn runs at least one workflow step, so a session with turns whose
 * run logged none is an incomplete export, not zero durable work.
 *
 * @param {{ sessionId: string, events: object[] }[]} roots
 * @param {Map<string, { events: object[] }> | undefined} world
 */
export function durability(roots, world) {
  if (world === undefined) return everyDurabilityMetric(unavailable("missing-world-probe"));
  let steps = 0;
  let inputBytes = 0;
  let outputBytes = 0;
  let turns = 0;
  let modelSteps = 0;
  for (const { sessionId, events } of roots) {
    const run = world.get(sessionId);
    if (!Array.isArray(run?.events)) return everyDurabilityMetric(unavailable("missing-world-run"));
    const sessionTurns = selectEvents(events, "turn.started").length;
    let sessionSteps = 0;
    for (const event of run.events) {
      if (event?.eventType === "step_created") {
        sessionSteps += 1;
        const bytes = event.payloadBytes?.input;
        if (bytes === undefined) return everyDurabilityMetric(unavailable("missing-step-payload"));
        inputBytes += bytes;
      } else if (event?.eventType === "step_completed") {
        const bytes = event.payloadBytes?.result;
        if (bytes === undefined) return everyDurabilityMetric(unavailable("missing-step-payload"));
        outputBytes += bytes;
      }
    }
    if (sessionTurns > 0 && sessionSteps === 0)
      return everyDurabilityMetric(unavailable("empty-world-run"));
    steps += sessionSteps;
    turns += sessionTurns;
    modelSteps += selectEvents(events, "step.started").length;
  }
  const perTurn = (value) => (turns === 0 ? notApplicable("no-turns") : measured(value / turns));
  return {
    "durability.workflow_steps_per_turn": perTurn(steps),
    "durability.step_input_bytes_per_turn": perTurn(inputBytes),
    "durability.step_output_bytes_per_turn": perTurn(outputBytes),
    "durability.workflow_steps_per_model_step":
      modelSteps === 0 ? notApplicable("no-model-steps") : measured(steps / modelSteps),
  };
}

function everyDurabilityMetric(measurement) {
  return Object.fromEntries(DURABILITY_METRICS.map((key) => [key, measurement]));
}

function measured(value) {
  return { status: "measured", value };
}

function perOccurrence(samples, reason) {
  if (samples.length === 0) return notApplicable(reason);
  return { status: "measured", value: median(samples), count: samples.length, samples };
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
