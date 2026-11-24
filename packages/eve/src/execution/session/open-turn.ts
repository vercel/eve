import type { DeliverHookPayload } from "#channel/types.js";
import type { TurnPause } from "#execution/session/pending-turn-state.js";
import type { TurnStepPayload, TurnStepResult } from "#execution/session/turn-step-types.js";
import type { ControlDelivery } from "#harness/types.js";

export type OpenTurn =
  | { readonly at: "step"; readonly input?: TurnStepPayload }
  | { readonly at: "pause"; readonly pause: TurnPause }
  | { readonly at: "cancel"; readonly report: boolean; readonly control?: ControlDelivery };

export function openedBy(input: DeliverHookPayload | undefined): OpenTurn | undefined {
  return input === undefined ? undefined : { at: "step", input: { delivery: input } };
}

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
