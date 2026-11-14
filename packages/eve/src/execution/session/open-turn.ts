import type { DeliverHookPayload } from "#channel/types.js";
import type { TurnPause } from "#execution/session/pending-turn-state.js";
import type { TurnStepPayload, TurnStepResult } from "#execution/session/turn-step-types.js";
import type { ControlDelivery } from "#harness/types.js";

// Only types and pure functions: the session loop runs this inside Workflow's workflow sandbox too.
//
// Where a session's open turn goes on. The session loop is its only writer: the state cursor holds
// it beside the session's values (`SessionStateCursor.open`), and a host that keeps sessions saves
// it with every record. A restore continues the turn from it (`SessionStart { kind: "resume" }`).

/**
 * Where an open turn goes on: its next step (the one that was running, with its input, or the one
 * after a step that returned), the wait its last step paused on, or the settle of a cancel that
 * stopped it.
 */
export type OpenTurn =
  | { readonly at: "step"; readonly input?: TurnStepPayload }
  | { readonly at: "pause"; readonly pause: TurnPause }
  /** A cancel stopped the turn, whose settle runs next; `report` tells its delegated caller. */
  | { readonly at: "cancel"; readonly report: boolean; readonly control?: ControlDelivery };

/** The turn a session's first message opens, before its first step runs. */
export function openedBy(input: DeliverHookPayload | undefined): OpenTurn | undefined {
  return input === undefined ? undefined : { at: "step", input: { delivery: input } };
}

/** Where the turn goes on after a step returned `result`: none once it ended or parked. */
export function openAfter(result: TurnStepResult): OpenTurn | undefined {
  switch (result.action) {
    case "continue":
      return { at: "step" };
    case "paused":
      return { at: "pause", pause: turnPauseOf(result) };
    default:
      return undefined;
  }
}

/** The deliveries the step `open` goes on with reads from its own input. */
export function deliveriesReadBy(open: OpenTurn | undefined): readonly string[] {
  switch (open?.at) {
    case "step":
      return [
        ...(open.input?.delivery?.deliveryMetadata ?? []).map(({ deliveryId }) => deliveryId),
        ...(open.input?.controlDelivery === undefined
          ? []
          : [open.input.controlDelivery.deliveryId]),
      ];
    case "cancel":
      return open.control === undefined ? [] : [open.control.deliveryId];
    default:
      return [];
  }
}

/** The pause a paused step's result names, without the rest of the result. */
function turnPauseOf(paused: TurnPause): TurnPause {
  switch (paused.on) {
    case "interaction":
      return { attemptIds: paused.attemptIds, on: "interaction", requestIds: paused.requestIds };
    case "tasks":
      return { on: "tasks", taskIds: paused.taskIds };
    case "calls":
      return {
        callIds: paused.callIds,
        dispatch: paused.dispatch,
        on: "calls",
        taskToolCalls: paused.taskToolCalls,
      };
  }
}
