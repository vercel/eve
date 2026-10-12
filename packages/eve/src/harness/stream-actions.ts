import type { RuntimeActionRequestProjection } from "#harness/action-presentation.js";
import { callRequested, callStarted } from "#harness/call-facts.js";
import type { HarnessEmitFn } from "#harness/types.js";
import type { SessionEvent } from "#protocol/session-event.js";

interface ActionEventCoordinates {
  readonly runId?: string;
  readonly turnId: string;
}

interface EmittedProviderAction {
  readonly request: RuntimeActionRequestProjection;
  readonly toolName: string;
}

interface ProviderStreamActionBatch {
  cancel(): Promise<void>;
  flush(): Promise<void>;
  observe(action: RuntimeActionRequestProjection, toolName: string): void;
}

/** Batches provider-managed calls that arrive in one streamed model response. */
export function createProviderStreamActionBatch(input: {
  readonly emitFn: HarnessEmitFn;
  readonly onActionsEmitted?: (actions: readonly EmittedProviderAction[]) => void;
  readonly state: ActionEventCoordinates;
}): ProviderStreamActionBatch {
  const pendingActions = new Map<string, EmittedProviderAction>();
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

    const actions = [...pendingActions.values()];
    pendingActions.clear();
    // The provider runs these as it streams: each is requested and started in one commit.
    const runId = input.state.runId ?? `${input.state.turnId}.run`;
    const scope = { runId, turnId: input.state.turnId };
    const commit: SessionEvent[] = actions.flatMap(({ request }) => [
      callRequested({
        action: request.action,
        owner: { runId },
        scope,
        title: request.presentationLabel,
      }),
      callStarted(request.action.callId, { clearedBy: { policy: "provider" }, scope }),
    ]);
    await input.emitFn(commit);
    input.onActionsEmitted?.(actions);
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
    observe(action, toolName) {
      if (cancelled) return;
      pendingActions.set(action.action.callId, { request: action, toolName });
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
