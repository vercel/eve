import type {
  TraceAction,
  TraceActionError,
  TraceActionKind,
  TraceStep,
  TraceTurn,
  TranscriptStreamEvent,
} from "./types";

type MutableTraceAction = {
  callId: string;
  durationMs?: number;
  endTime?: string;
  error?: TraceActionError;
  input?: unknown;
  kind: TraceActionKind;
  name: string;
  output?: unknown;
  startTime?: string;
  status: TraceAction["status"];
};

type MutableTraceStep = {
  actions: MutableTraceAction[];
  actionCount: number;
  actionsByCallId: Map<string, MutableTraceAction>;
  durationMs?: number;
  endTime?: string;
  errorMessage?: string;
  events: TranscriptStreamEvent[];
  finishReason?: string;
  reasoningText?: string;
  responseText?: string;
  startTime?: string;
  status: TraceStep["status"];
  stepIndex: number;
  subagentCount: number;
  usage?: TraceStep["usage"];
};

type MutableTraceTurn = {
  assistantMessage?: string;
  durationMs?: number;
  endTime?: string;
  events: TranscriptStreamEvent[];
  sequence?: number;
  startTime?: string;
  status: TraceTurn["status"];
  steps: MutableTraceStep[];
  stepsByIndex: Map<number, MutableTraceStep>;
  subagentCount: number;
  turnId: string;
  userMessage?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function readEventTimestamp(event: TranscriptStreamEvent): string | undefined {
  return readString(event.meta?.at);
}

function getEventTurnId(event: TranscriptStreamEvent): string | undefined {
  if (!isRecord(event.data)) {
    return undefined;
  }

  return readString(event.data.turnId);
}

function getEventSequence(event: TranscriptStreamEvent): number | undefined {
  if (!isRecord(event.data)) {
    return undefined;
  }

  return readNumber(event.data.sequence);
}

function getEventStepIndex(event: TranscriptStreamEvent): number | undefined {
  if (!isRecord(event.data)) {
    return undefined;
  }

  return readNumber(event.data.stepIndex);
}

function ensureTurn(
  orderedTurns: MutableTraceTurn[],
  turnsById: Map<string, MutableTraceTurn>,
  turnId: string,
): MutableTraceTurn {
  const existing = turnsById.get(turnId);
  if (existing !== undefined) {
    return existing;
  }

  const nextTurn: MutableTraceTurn = {
    events: [],
    status: "running",
    steps: [],
    stepsByIndex: new Map(),
    subagentCount: 0,
    turnId,
  };
  turnsById.set(turnId, nextTurn);
  orderedTurns.push(nextTurn);
  return nextTurn;
}

function ensureStep(turn: MutableTraceTurn, stepIndex: number): MutableTraceStep {
  const existing = turn.stepsByIndex.get(stepIndex);
  if (existing !== undefined) {
    return existing;
  }

  const nextStep: MutableTraceStep = {
    actions: [],
    actionCount: 0,
    actionsByCallId: new Map(),
    events: [],
    status: "running",
    stepIndex,
    subagentCount: 0,
  };
  turn.stepsByIndex.set(stepIndex, nextStep);
  turn.steps.push(nextStep);
  return nextStep;
}

function getMostRecentStep(turn: MutableTraceTurn): MutableTraceStep | undefined {
  return turn.steps[turn.steps.length - 1];
}

function createTraceAction(input: {
  readonly callId: string;
  readonly input?: unknown;
  readonly kind: TraceActionKind;
  readonly name: string;
  readonly status?: TraceAction["status"];
}): MutableTraceAction {
  return {
    callId: input.callId,
    input: input.input,
    kind: input.kind,
    name: input.name,
    status: input.status ?? "requested",
  };
}

function ensureAction(step: MutableTraceStep, action: MutableTraceAction): MutableTraceAction {
  const existing = step.actionsByCallId.get(action.callId);
  if (existing !== undefined) {
    return existing;
  }

  step.actionsByCallId.set(action.callId, action);
  step.actions.push(action);
  step.actionCount = step.actions.length;
  return action;
}

function getTraceActionKindFromRequest(action: Record<string, unknown>): TraceActionKind {
  const kind = readString(action.kind);
  switch (kind) {
    case "load-skill":
    case "subagent-call":
    case "tool-call":
      return kind;
    default:
      return "unknown";
  }
}

function getTraceActionKindFromResult(result: Record<string, unknown>): TraceActionKind {
  const kind = readString(result.kind);
  switch (kind) {
    case "load-skill-result":
      return "load-skill";
    case "subagent-result":
      return "subagent-call";
    case "tool-result":
      return "tool-call";
    default:
      return "unknown";
  }
}

function getTraceActionNameFromRequest(action: Record<string, unknown>): string | undefined {
  const kind = getTraceActionKindFromRequest(action);
  switch (kind) {
    case "load-skill":
      return "load_skill";
    case "subagent-call":
      return readString(action.subagentName) ?? readString(action.name);
    case "tool-call":
      return readString(action.toolName);
    case "unknown":
      return (
        readString(action.toolName) ?? readString(action.subagentName) ?? readString(action.name)
      );
  }
}

function getTraceActionNameFromResult(result: Record<string, unknown>): string | undefined {
  const kind = getTraceActionKindFromResult(result);
  switch (kind) {
    case "load-skill":
      return readString(result.name) ?? "load_skill";
    case "subagent-call":
      return readString(result.subagentName);
    case "tool-call":
      return readString(result.toolName);
    case "unknown":
      return (
        readString(result.toolName) ?? readString(result.subagentName) ?? readString(result.name)
      );
  }
}

function readActionResultError(value: unknown): TraceActionError | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const code = readString(value.code);
  const message = readString(value.message);
  if (code === undefined || message === undefined) {
    return undefined;
  }

  return {
    code,
    message,
  };
}

function getTraceActionStatusFromResult(eventData: Record<string, unknown>): TraceAction["status"] {
  const normalizedStatus = readString(eventData.status);
  if (normalizedStatus === "completed" || normalizedStatus === "failed") {
    return normalizedStatus;
  }

  return readActionResultError(eventData.error) !== undefined ? "failed" : "completed";
}

function getTraceActionErrorFromResult(
  eventData: Record<string, unknown>,
): TraceActionError | undefined {
  return readActionResultError(eventData.error);
}

function abortOpenTraceWork(input: {
  readonly endedAt?: string;
  readonly message?: string;
  readonly turn: MutableTraceTurn;
}): void {
  for (const step of input.turn.steps) {
    if (step.status === "running") {
      if (input.endedAt !== undefined && step.endTime === undefined) {
        step.endTime = input.endedAt;
      }
      if (input.message !== undefined && step.errorMessage === undefined) {
        step.errorMessage = input.message;
      }
      step.status = "aborted";
    }

    for (const action of step.actions) {
      if (action.status !== "requested" && action.status !== "running") {
        continue;
      }

      if (input.endedAt !== undefined && action.endTime === undefined) {
        action.endTime = input.endedAt;
      }
      action.status = "aborted";
    }
  }
}

function applyDuration(input: {
  readonly endTime?: string;
  readonly setDuration: (durationMs: number | undefined) => void;
  readonly startTime?: string;
}): void {
  if (input.startTime === undefined || input.endTime === undefined) {
    input.setDuration(undefined);
    return;
  }

  const startMs = Date.parse(input.startTime);
  const endMs = Date.parse(input.endTime);

  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
    input.setDuration(undefined);
    return;
  }

  input.setDuration(endMs - startMs);
}

function toReadonlyTurn(turn: MutableTraceTurn): TraceTurn {
  return {
    assistantMessage: turn.assistantMessage,
    durationMs: turn.durationMs,
    endTime: turn.endTime,
    events: turn.events,
    sequence: turn.sequence,
    startTime: turn.startTime,
    status: turn.status,
    steps: turn.steps.map((step) => ({
      actions: step.actions.map((action) => ({
        callId: action.callId,
        durationMs: action.durationMs,
        endTime: action.endTime,
        error: action.error,
        input: action.input,
        kind: action.kind,
        name: action.name,
        output: action.output,
        startTime: action.startTime,
        status: action.status,
      })),
      actionCount: step.actionCount,
      durationMs: step.durationMs,
      endTime: step.endTime,
      errorMessage: step.errorMessage,
      events: step.events,
      finishReason: step.finishReason,
      reasoningText: step.reasoningText,
      responseText: step.responseText,
      startTime: step.startTime,
      status: step.status,
      stepIndex: step.stepIndex,
      subagentCount: step.subagentCount,
      usage: step.usage,
    })),
    subagentCount: turn.subagentCount,
    turnId: turn.turnId,
    userMessage: turn.userMessage,
  };
}

/**
 * Reconstructs the shared turn model from the persisted session transcript.
 *
 * The web UI renders both chat and debugger surfaces from this one transcript-
 * first view, deriving durations from event timestamps when available.
 */
export function buildTraceTurnsFromTranscript(
  events: readonly TranscriptStreamEvent[],
): readonly TraceTurn[] {
  const orderedTurns: MutableTraceTurn[] = [];
  const turnsById = new Map<string, MutableTraceTurn>();
  let lastTurnId: string | undefined;

  for (const event of events) {
    let turnId = getEventTurnId(event);

    if (
      turnId === undefined &&
      lastTurnId !== undefined &&
      (event.type === "session.completed" ||
        event.type === "session.failed" ||
        event.type === "session.waiting")
    ) {
      turnId = lastTurnId;
    }

    if (turnId === undefined) {
      continue;
    }

    const turn = ensureTurn(orderedTurns, turnsById, turnId);
    turn.events.push(event);
    lastTurnId = turnId;

    const sequence = getEventSequence(event);
    if (sequence !== undefined) {
      turn.sequence = sequence;
    }

    const eventTimestamp = readEventTimestamp(event);
    const eventStepIndex = getEventStepIndex(event);
    const step =
      eventStepIndex !== undefined ? ensureStep(turn, eventStepIndex) : getMostRecentStep(turn);

    if (step !== undefined && eventStepIndex !== undefined) {
      step.events.push(event);
    } else if (step !== undefined && event.type === "subagent.called") {
      step.events.push(event);
    }

    if (event.type === "turn.started") {
      if (eventTimestamp !== undefined) {
        turn.startTime = eventTimestamp;
      }
      continue;
    }

    if (event.type === "message.received" && isRecord(event.data)) {
      turn.userMessage = readString(event.data.message);
      continue;
    }

    if (event.type === "step.started" && step !== undefined) {
      if (eventTimestamp !== undefined) {
        step.startTime = eventTimestamp;
      }
      step.status = "running";
      continue;
    }

    if (event.type === "reasoning.appended" && step !== undefined && isRecord(event.data)) {
      step.reasoningText = readString(event.data.reasoningSoFar);
      continue;
    }

    if (event.type === "reasoning.completed" && step !== undefined && isRecord(event.data)) {
      step.reasoningText = readString(event.data.reasoning);
      continue;
    }

    if (event.type === "message.appended" && step !== undefined && isRecord(event.data)) {
      step.responseText = readString(event.data.messageSoFar);
      continue;
    }

    if (event.type === "message.completed" && step !== undefined && isRecord(event.data)) {
      const message = readString(event.data.message);
      const finishReason = readString(event.data.finishReason);

      if (finishReason !== undefined) {
        step.finishReason = finishReason;
      }

      if (message !== undefined) {
        step.responseText = message;
        if (finishReason !== "tool-calls") {
          turn.assistantMessage = message;
        }
      }
      continue;
    }

    if (event.type === "actions.requested" && step !== undefined && isRecord(event.data)) {
      const actions = event.data.actions;
      if (Array.isArray(actions)) {
        for (const actionValue of actions) {
          if (!isRecord(actionValue)) {
            continue;
          }

          const callId = readString(actionValue.callId);
          const name = getTraceActionNameFromRequest(actionValue);
          if (callId === undefined || name === undefined) {
            continue;
          }

          const action = ensureAction(
            step,
            createTraceAction({
              callId,
              input: actionValue.input,
              kind: getTraceActionKindFromRequest(actionValue),
              name,
              status: "running",
            }),
          );
          action.input = actionValue.input;
          action.status = "running";
          if (eventTimestamp !== undefined && action.startTime === undefined) {
            action.startTime = eventTimestamp;
          }
        }
      }
      continue;
    }

    if (event.type === "input.requested" && step !== undefined && isRecord(event.data)) {
      const requests = event.data.requests;
      if (Array.isArray(requests)) {
        for (const requestValue of requests) {
          if (!isRecord(requestValue)) {
            continue;
          }

          const actionValue = requestValue.action;
          if (!isRecord(actionValue)) {
            continue;
          }

          const callId = readString(actionValue.callId);
          const name = getTraceActionNameFromRequest(actionValue);
          if (callId === undefined || name === undefined) {
            continue;
          }

          const action = ensureAction(
            step,
            createTraceAction({
              callId,
              input: actionValue.input,
              kind: getTraceActionKindFromRequest(actionValue),
              name,
              status: "requested",
            }),
          );
          action.input = actionValue.input;
          action.status = "requested";
          if (eventTimestamp !== undefined && action.startTime === undefined) {
            action.startTime = eventTimestamp;
          }
        }
      }
      continue;
    }

    if (event.type === "action.result" && step !== undefined && isRecord(event.data)) {
      const resultValue = event.data.result;
      if (!isRecord(resultValue)) {
        continue;
      }

      const callId = readString(resultValue.callId);
      const name = getTraceActionNameFromResult(resultValue);
      if (callId === undefined || name === undefined) {
        continue;
      }

      const action = ensureAction(
        step,
        createTraceAction({
          callId,
          kind: getTraceActionKindFromResult(resultValue),
          name,
        }),
      );

      action.kind = getTraceActionKindFromResult(resultValue);
      action.name = name;
      action.output = resultValue.output;
      action.status = getTraceActionStatusFromResult(event.data);
      action.error = getTraceActionErrorFromResult(event.data);
      if (eventTimestamp !== undefined) {
        action.endTime = eventTimestamp;
      }
      continue;
    }

    if (event.type === "subagent.called") {
      turn.subagentCount += 1;
      if (step !== undefined) {
        step.subagentCount += 1;
      }
      continue;
    }

    if (event.type === "step.completed" && step !== undefined && isRecord(event.data)) {
      const finishReason = readString(event.data.finishReason);
      if (finishReason !== undefined) {
        step.finishReason = finishReason;
      }

      if (eventTimestamp !== undefined) {
        step.endTime = eventTimestamp;
      }
      step.status = "completed";

      const usageValue = event.data.usage;
      if (isRecord(usageValue)) {
        step.usage = {
          cacheReadTokens: readNumber(usageValue.cacheReadTokens),
          cacheWriteTokens: readNumber(usageValue.cacheWriteTokens),
          inputTokens: readNumber(usageValue.inputTokens),
          outputTokens: readNumber(usageValue.outputTokens),
        };
      }
      continue;
    }

    if (event.type === "step.failed" && step !== undefined && isRecord(event.data)) {
      if (eventTimestamp !== undefined) {
        step.endTime = eventTimestamp;
      }
      step.errorMessage = readString(event.data.message);
      for (const action of step.actions) {
        if (action.status !== "requested" && action.status !== "running") {
          continue;
        }

        if (eventTimestamp !== undefined && action.endTime === undefined) {
          action.endTime = eventTimestamp;
        }
        action.status = "aborted";
      }
      step.status = "failed";
      continue;
    }

    if (event.type === "turn.completed") {
      if (eventTimestamp !== undefined) {
        turn.endTime = eventTimestamp;
      }
      turn.status = "completed";
      continue;
    }

    if (event.type === "turn.failed" || event.type === "session.failed") {
      const failureMessage =
        isRecord(event.data) && typeof event.data.message === "string"
          ? event.data.message
          : undefined;
      if (eventTimestamp !== undefined) {
        turn.endTime = eventTimestamp;
      }
      abortOpenTraceWork({
        endedAt: eventTimestamp,
        message: failureMessage,
        turn,
      });
      turn.status = "failed";
      continue;
    }

    if (
      event.type === "session.waiting" &&
      turn.endTime === undefined &&
      eventTimestamp !== undefined
    ) {
      turn.endTime = eventTimestamp;
    }
  }

  for (const turn of orderedTurns) {
    applyDuration({
      endTime: turn.endTime,
      setDuration: (durationMs) => {
        turn.durationMs = durationMs;
      },
      startTime: turn.startTime,
    });

    for (const step of turn.steps) {
      applyDuration({
        endTime: step.endTime,
        setDuration: (durationMs) => {
          step.durationMs = durationMs;
        },
        startTime: step.startTime,
      });

      for (const action of step.actions) {
        applyDuration({
          endTime: action.endTime,
          setDuration: (durationMs) => {
            action.durationMs = durationMs;
          },
          startTime: action.startTime,
        });
      }
    }
  }

  return orderedTurns.map(toReadonlyTurn);
}
