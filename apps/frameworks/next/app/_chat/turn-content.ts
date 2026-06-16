import type { TraceAction, TraceTurn } from "./types";

export type TurnContentItem =
  | {
      readonly key: string;
      readonly kind: "actions";
      readonly items: readonly TraceAction[];
      readonly stepIndex: number;
    }
  | {
      readonly key: string;
      readonly kind: "response";
      readonly stepIndex: number;
      readonly text: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readCallIdsFromActionsRequestedEvent(event: {
  readonly data?: unknown;
}): readonly string[] {
  if (!isRecord(event.data) || !Array.isArray(event.data.actions)) {
    return [];
  }

  const callIds: string[] = [];
  for (const action of event.data.actions) {
    if (!isRecord(action)) {
      continue;
    }

    const callId = readString(action.callId);
    if (callId !== undefined) {
      callIds.push(callId);
    }
  }

  return callIds;
}

function readCallIdsFromInputRequestedEvent(event: { readonly data?: unknown }): readonly string[] {
  if (!isRecord(event.data) || !Array.isArray(event.data.requests)) {
    return [];
  }

  const callIds: string[] = [];
  for (const request of event.data.requests) {
    if (!isRecord(request) || !isRecord(request.action)) {
      continue;
    }

    const callId = readString(request.action.callId);
    if (callId !== undefined) {
      callIds.push(callId);
    }
  }

  return callIds;
}

function readMessageFromCompletedEvent(event: { readonly data?: unknown }): string | undefined {
  if (!isRecord(event.data)) {
    return undefined;
  }

  return readString(event.data.message);
}

/**
 * Resolves the most useful assistant-facing failure text for a turn when no
 * normal assistant message was completed.
 */
export function resolveTurnFailureMessage(turn: TraceTurn): string | undefined {
  for (const step of turn.steps) {
    if (typeof step.errorMessage === "string" && step.errorMessage.length > 0) {
      return step.errorMessage;
    }
  }

  for (const event of turn.events) {
    if (
      event.type === "session.failed" &&
      isRecord(event.data) &&
      typeof event.data.message === "string" &&
      event.data.message.length > 0
    ) {
      return event.data.message;
    }
  }

  return undefined;
}

/**
 * Determines whether the conversation surface should render an assistant row
 * for the provided turn.
 */
export function shouldRenderAssistantTurn(turn: TraceTurn): boolean {
  if (typeof turn.assistantMessage === "string" && turn.assistantMessage.length > 0) {
    return true;
  }

  if (turn.status === "failed") {
    return true;
  }

  return turn.steps.some((step) => {
    return (
      (typeof step.responseText === "string" && step.responseText.length > 0) ||
      step.actions.length > 0
    );
  });
}

/**
 * Builds the ordered assistant content blocks for one turn directly from the
 * persisted transcript event order. This keeps tool calls and text in the same
 * sequence the model/runtime produced them.
 */
export function buildTurnContentItems(turn: TraceTurn): readonly TurnContentItem[] {
  const items: TurnContentItem[] = [];

  for (const step of turn.steps) {
    const actionsByCallId = new Map(step.actions.map((action) => [action.callId, action] as const));
    const emittedActionCallIds = new Set<string>();
    let emittedResponse = false;

    for (const event of step.events) {
      if (event.type === "actions.requested" || event.type === "input.requested") {
        const requestedCallIds =
          event.type === "actions.requested"
            ? readCallIdsFromActionsRequestedEvent(event)
            : readCallIdsFromInputRequestedEvent(event);
        const requestedActions: TraceAction[] = [];

        for (const callId of requestedCallIds) {
          const action = actionsByCallId.get(callId);
          if (action === undefined || emittedActionCallIds.has(callId)) {
            continue;
          }

          emittedActionCallIds.add(callId);
          requestedActions.push(action);
        }

        if (requestedActions.length > 0) {
          items.push({
            items: requestedActions,
            key: `step:${step.stepIndex}:actions:${items.length}`,
            kind: "actions",
            stepIndex: step.stepIndex,
          });
        }
        continue;
      }

      if (event.type === "message.completed") {
        const message = readMessageFromCompletedEvent(event);
        if (message !== undefined) {
          items.push({
            key: `step:${step.stepIndex}:response`,
            kind: "response",
            stepIndex: step.stepIndex,
            text: message,
          });
          emittedResponse = true;
        }
      }
    }

    if (!emittedResponse && typeof step.responseText === "string" && step.responseText.length > 0) {
      items.push({
        key: `step:${step.stepIndex}:response:fallback`,
        kind: "response",
        stepIndex: step.stepIndex,
        text: step.responseText,
      });
    }

    const remainingActions = step.actions.filter((action) => {
      return !emittedActionCallIds.has(action.callId);
    });
    if (remainingActions.length > 0) {
      items.push({
        items: remainingActions,
        key: `step:${step.stepIndex}:actions:fallback`,
        kind: "actions",
        stepIndex: step.stepIndex,
      });
    }
  }

  return items;
}
