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

/**
 * Resolves the latest assistant text, including a response that is still
 * streaming and has not completed yet.
 */
export function resolveTurnAssistantMessage(turn: TraceTurn): string | undefined {
  if (typeof turn.assistantMessage === "string" && turn.assistantMessage.length > 0) {
    return turn.assistantMessage;
  }

  for (let index = turn.steps.length - 1; index >= 0; index -= 1) {
    const responseText = turn.steps[index]?.responseText;
    if (typeof responseText === "string" && responseText.length > 0) {
      return responseText;
    }
  }

  return undefined;
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
  return turn.failureMessage;
}

/**
 * Determines whether the conversation surface should render an assistant row
 * for the provided turn.
 */
export function shouldRenderAssistantTurn(turn: TraceTurn): boolean {
  if (resolveTurnAssistantMessage(turn) !== undefined) {
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
 * Builds the ordered assistant content blocks for one turn. Within a model run the text the
 * model wrote comes before the calls it made, so each step renders its text, then its calls.
 */
export function buildTurnContentItems(turn: TraceTurn): readonly TurnContentItem[] {
  const items: TurnContentItem[] = [];
  for (const step of turn.steps) {
    if (typeof step.responseText === "string" && step.responseText.length > 0) {
      items.push({
        key: `step:${step.stepIndex}:response`,
        kind: "response",
        stepIndex: step.stepIndex,
        text: step.responseText,
      });
    }
    if (step.actions.length > 0) {
      items.push({
        items: step.actions,
        key: `step:${step.stepIndex}:actions`,
        kind: "actions",
        stepIndex: step.stepIndex,
      });
    }
  }
  return items;
}
