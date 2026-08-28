import { createActionsRequestedEvent } from "#protocol/message.js";
import {
  collectActionActivityLabels,
  type RuntimeActionRequestProjection,
} from "#harness/action-activity.js";
import type { HarnessEmitFn } from "#harness/types.js";

interface ActionEventCoordinates {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

interface ProviderStreamActionBatch {
  cancel(): Promise<void>;
  flush(): Promise<void>;
  observe(action: RuntimeActionRequestProjection): void;
}

/** Batches provider-managed calls that arrive in one streamed model response. */
export function createProviderStreamActionBatch(input: {
  readonly emitFn: HarnessEmitFn;
  readonly state: ActionEventCoordinates;
}): ProviderStreamActionBatch {
  const pendingActions = new Map<string, RuntimeActionRequestProjection>();
  let actionFlush: Promise<void> = Promise.resolve();
  let actionFlushError: unknown;
  let actionFlushTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let resolveActionFlushTimer: (() => void) | undefined;

  const emitPendingActions = async (): Promise<void> => {
    if (cancelled) {
      pendingActions.clear();
      return;
    }
    if (pendingActions.size === 0) return;

    const projections = [...pendingActions.values()];
    pendingActions.clear();
    await input.emitFn(
      createActionsRequestedEvent({
        actions: projections.map(({ action }) => action),
        sequence: input.state.sequence,
        stepIndex: input.state.stepIndex,
        turnId: input.state.turnId,
      }),
      undefined,
      collectActionActivityLabels(projections),
    );
  };

  const scheduleFlush = (): void => {
    if (cancelled) return;
    if (actionFlushTimer !== undefined) return;

    let resolveTimer: (() => void) | undefined;
    const timerElapsed = new Promise<void>((resolve) => {
      resolveTimer = resolve;
    });
    resolveActionFlushTimer = resolveTimer;
    actionFlushTimer = setTimeout(() => {
      actionFlushTimer = undefined;
      resolveActionFlushTimer = undefined;
      resolveTimer?.();
    }, 0);
    actionFlush = actionFlush
      .then(() => timerElapsed)
      .then(emitPendingActions)
      .catch((error: unknown) => {
        actionFlushError ??= error;
      });
  };

  const releaseFlushTimer = (): void => {
    if (actionFlushTimer === undefined) return;

    clearTimeout(actionFlushTimer);
    actionFlushTimer = undefined;
    const resolveTimer = resolveActionFlushTimer;
    resolveActionFlushTimer = undefined;
    resolveTimer?.();
  };

  return {
    async cancel() {
      cancelled = true;
      pendingActions.clear();
      releaseFlushTimer();
      await actionFlush;
    },
    observe(action) {
      if (cancelled) return;
      pendingActions.set(action.action.callId, action);
      scheduleFlush();
    },
    async flush() {
      if (cancelled) return;
      releaseFlushTimer();

      await actionFlush;
      if (actionFlushError !== undefined) throw actionFlushError;
      await emitPendingActions();
    },
  };
}
