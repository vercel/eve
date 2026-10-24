import type { DeliverHookPayload } from "#channel/types.js";
import { controlDeliveryOf } from "#execution/session/control-delivery.js";
import { firstAnswering, takeAnswering } from "#execution/session/scheduler/answers.js";
import { accept } from "#execution/session/scheduler/events.js";
import {
  heldControls,
  heldDeliveries,
  heldDelivery,
  isSteeringMessage,
  takeSignIns,
  takeSteering,
} from "#execution/session/scheduler/held.js";
import type { Made, Next, SessionReading } from "#execution/session/scheduler/next.js";
import {
  inTurn,
  takes,
  waiting,
  type Calls,
  type Report,
  type Scheduler,
  type TaskWait,
  type Turn,
  type Wait,
} from "#execution/session/scheduler/state.js";
import type {
  RuntimeActionResultStepInput,
  TurnStepPayload,
} from "#execution/session/turn-step-types.js";
import { isAppliedRunMessage } from "#execution/tools/workflow/messages.js";
import { taskToolResult, taskWaitResult } from "#execution/tasks/calls.js";
import { renderTaskWaitResult } from "#execution/tasks/render.js";
import {
  runMessageBatchBudget,
  type WorkflowToolRunMessage,
} from "#execution/tools/workflow/messages.js";
import { formatEarlierRemoteCallerInputError } from "#protocol/remote-agent-protocol.js";
import { TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";

// A turn that waits, and takes what its next step reads:
//
// - a person's answer, a sign-in callback, or the turn's own person steering it, for the requests
//   and sign-ins it raised. Anyone else's message waits behind the turn, as does a message the
//   turn admitted before the step that raised the request (`heldSince`): it was sent before the
//   request existed;
// - one of its tasks settling. Steering interrupts that wait;
// - every call's result. Steering interrupts the workflow tool calls, which still report.
//
// Until then it takes in what its runs report, puts everything it holds on the stream, and waits
// on the inbox. What it holds already went to the children it answers (`next.ts`).

const NO_INPUT_CAPABILITY_ERROR_MESSAGE =
  "This session cannot request human input, so it cannot wait for a tool approval or question. " +
  "Configure unattended tools with an approval policy that does not require human input.";

/** Why the session can't wait on a person for `requests`, when it can't. */
export function cannotAsk(requests: number, session: SessionReading): string | undefined {
  const earlier = session.earlierRemoteCaller;
  if (earlier !== undefined) return formatEarlierRemoteCallerInputError(earlier);
  if (requests > 0 && !session.canAskPeople) return NO_INPUT_CAPABILITY_ERROR_MESSAGE;
  return undefined;
}

/**
 * What a waiting turn does next, first to last: it starts the runs and task tool calls of what it
 * waits on; takes what it waits on, once that's here; stops, if a cancel stopped it; stops its
 * runs, if its person steered it; takes in what its runs reported; puts everything it holds on the
 * stream; and otherwise waits on the inbox.
 */
export function waitOn(state: Scheduler, turn: Turn, wait: Wait, session: SessionReading): Made {
  if (wait.on === "calls" && wait.dispatch)
    return {
      state: waiting(state, turn, { ...wait, dispatch: false }),
      asks: { kind: "dispatch" },
    };
  if (wait.on === "calls" && wait.taskToolCalls !== undefined)
    return { state, asks: { calls: wait.taskToolCalls, kind: "start-task-calls" } };
  const current = wait.on === "calls" ? resolveTaskWaits(wait, wait.interrupted, session) : wait;
  const taken = takeAwaited(state, turn, current, session);
  if (taken !== undefined) return taken;
  // A turn waiting on its person looked for what steers it: nothing it saw interrupts what's next.
  const looked: Turn = current.on === "interaction" ? { ...turn, rearm: true } : turn;
  if (turn.stopping) return { state: inTurn(state, { ...looked, at: { kind: "stopped" } }) };
  if (!current.interrupted && steeredBy(state, turn)) {
    // Only the first steering message interrupts; later ones wait for the calls anyway.
    const interrupted = waiting(state, looked, { ...current, interrupted: true });
    if (current.on !== "calls") return { state: interrupted };
    const callIds = current.callIds.filter((callId) => current.acceptedAtMs[callId] === undefined);
    return { state: interrupted, asks: { callIds, kind: "interrupt-runs" } };
  }
  const [report, ...reports] = turn.reports;
  if (report?.kind === "results") {
    // Results through the inbox count only from runs the turn recorded.
    if (current.on !== "calls") return { state: waiting(state, looked, current, { reports }) };
    const now = session.now;
    const accepted = report.results
      .filter(
        (result) =>
          result.kind === "tool-result" &&
          session.recordedRuns.get(result.callId) === result.toolName,
      )
      .reduce((calls, result) => accept(calls, result, now), current);
    return { state: waiting(state, looked, accepted, { reports }) };
  }
  if (report?.kind === "run") {
    const { message } = report;
    if (!isAppliedRunMessage(message))
      return {
        state: waiting(state, looked, current, { reports }),
        asks: { kind: "handle-run-message", message },
      };
    // Run messages read one after another share one step, as a fan-out's do: those the turn
    // already admitted first, then those still in the inbox, so arrival order holds.
    const following = leadingAppliedRunMessages(reports);
    return {
      state: waiting(state, looked, current, { reports: reports.slice(following.length) }),
      asks: applyRunMessages([message, ...following], {
        canCancelTurn: true,
        fromInbox: following.length === reports.length,
      }),
    };
  }
  const settled = waiting(state, looked, current);
  // Whatever the turn holds and can't take yet, such as someone else's message, is on the
  // stream before the session waits.
  const deliveries = heldDeliveries(state.held);
  const controls = heldControls(state.held).map(({ control, origin }) => ({
    control,
    delivery: controlDeliveryOf(origin),
  }));
  const ids = [
    ...deliveries.flatMap((delivery) =>
      (delivery.deliveryMetadata ?? []).map((entry) => entry.deliveryId),
    ),
    ...controls.map(({ delivery }) => delivery.deliveryId),
  ];
  if (!ids.every((id) => session.view.deliveries[id] !== undefined))
    return { state: settled, asks: { controls, deliveries, kind: "admit-held" } };
  let timeout: Extract<Next, { kind: "wait" }>["timeout"];
  if (current.on === "calls")
    for (const { callId, deadlineMs } of current.taskWaits)
      if (deadlineMs !== undefined && (timeout === undefined || deadlineMs < timeout.deadlineMs))
        timeout = { callId, deadlineMs };
  return { state: settled, asks: { kind: "wait", ...(timeout && { timeout }) } };
}

/** What the turn waits on, taken once it's here: its next step runs with it. */
function takeAwaited(
  state: Scheduler,
  turn: Turn,
  wait: Wait,
  session: SessionReading,
): Made | undefined {
  const steps = (base: Omit<TurnStepPayload, "delivery">): Made => ({
    state: inTurn(state, { ...turn, at: { base, kind: "steering" } }),
  });
  switch (wait.on) {
    case "interaction": {
      const signIns = takeSignIns(state.held, new Set(wait.attemptIds));
      if (signIns.payloads !== undefined) {
        const delivery: DeliverHookPayload = { kind: "deliver", payloads: [...signIns.payloads] };
        return {
          state: inTurn(
            { ...state, held: signIns.held },
            { ...turn, at: { input: { delivery }, kind: "step" } },
          ),
        };
      }
      const answering = firstAnswering(state.held, turn, new Set(wait.requestIds));
      if (answering?.kind === "answers")
        return { state: takeAnswering(state, turn, answering.sequence, answering.delivery) };
      if (answering?.kind === "others")
        return {
          state: inTurn(state, { ...turn, mapped: [...turn.mapped, answering.sequence] }),
          asks: { delivery: answering.delivery, kind: "map-answers", requestIds: wait.requestIds },
        };
      const { held, selection } = takeSteering(
        state.held,
        turn.admitted,
        turn.steerer,
        wait.heldSince,
      );
      return selection === undefined
        ? undefined
        : { state: inTurn({ ...state, held }, takes(turn, selection)) };
    }
    case "tasks": {
      const wake = { interrupted: wait.interrupted, timedOut: false };
      return taskWaitResult(session.tasks, wake) === undefined ? undefined : steps({});
    }
    case "calls": {
      const ready = readyResults(wait);
      return ready === undefined ? undefined : steps({ runtimeResults: ready });
    }
  }
}

/** The turn's own person sent a message that steers it, which it holds. */
function steeredBy(state: Scheduler, turn: Turn): boolean {
  return turn.admitted.some((sequence) => {
    const delivery = heldDelivery(state.held, sequence);
    return delivery !== undefined && isSteeringMessage(delivery, turn.steerer);
  });
}

/** Answers every `eve__task_wait` that can return now; the rest wait on. */
function resolveTaskWaits<C extends Calls>(
  calls: C,
  interrupted: boolean,
  session: SessionReading,
): C {
  let resolved = calls;
  const waits: TaskWait[] = [];
  for (const wait of calls.taskWaits) {
    const result = taskWaitResult(session.tasks, { interrupted, timedOut: wait.timedOut });
    if (result === undefined) {
      waits.push(wait);
      continue;
    }
    const now = session.now;
    const text = renderTaskWaitResult(result, now - wait.startedAtMs);
    resolved = accept(resolved, taskToolResult(wait.callId, TASK_WAIT_TOOL_NAME, text), now);
  }
  return { ...resolved, taskWaits: waits };
}

/** Every call's result, once each has one. */
function readyResults(calls: Calls): RuntimeActionResultStepInput | undefined {
  const ready = resolveRuntimeActionResultsForCallIds({
    pendingCallIds: calls.callIds,
    results: calls.results,
  });
  if (ready === undefined) return undefined;
  const delegatedUsage = ready.flatMap((result) => {
    const usage = calls.delegatedUsage[result.callId];
    return usage === undefined ? [] : [[result.callId, usage] as const];
  });
  return {
    acceptedAtMsByCallId: Object.fromEntries(
      ready.map((result) => [result.callId, calls.acceptedAtMs[result.callId]!]),
    ),
    ...(delegatedUsage.length > 0 && { delegatedUsage: Object.fromEntries(delegatedUsage) }),
    results: ready,
  };
}

/** The run messages right behind one the turn takes, while each is applied as read and they fit one batch. */
function leadingAppliedRunMessages(reports: readonly Report[]): WorkflowToolRunMessage[] {
  const admits = runMessageBatchBudget();
  const taken: WorkflowToolRunMessage[] = [];
  for (const report of reports) {
    if (report.kind !== "run" || !isAppliedRunMessage(report.message) || !admits(report.message))
      break;
    taken.push(report.message);
  }
  return taken;
}

/** Applies run messages, if there are any. An ending session drops the children they open. */
export function applyRunMessages(
  messages: readonly WorkflowToolRunMessage[],
  options: {
    readonly canCancelTurn: boolean;
    readonly fromInbox?: boolean;
  },
): Next | undefined {
  if (messages.length === 0 && options.fromInbox !== true) return undefined;
  return {
    canCancelTurn: options.canCancelTurn,
    fromInbox: options.fromInbox === true,
    kind: "apply-run-messages",
    messages,
  };
}
