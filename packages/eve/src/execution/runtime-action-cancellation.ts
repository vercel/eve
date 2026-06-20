import { createHook } from "#compiled/@workflow/core/index.js";

export interface LocalRuntimeActionCancellationTarget {
  readonly cancelToken: string;
  readonly kind: "local";
  readonly nodeId: string;
  readonly sessionId: string;
}

export interface RemoteRuntimeActionCancellationTarget {
  readonly cancelToken: string;
  readonly kind: "remote";
  readonly nodeId: string;
  readonly sessionId: string;
}

export type RuntimeActionCancellationTarget =
  | LocalRuntimeActionCancellationTarget
  | RemoteRuntimeActionCancellationTarget;

export interface RuntimeActionDispatchResult {
  readonly cancellationTargets: readonly RuntimeActionCancellationTarget[];
}

/** Derives the driver-owned hook token used while runtime actions are active. */
export function createRuntimeActionCancellationHookToken(cancelToken: string): string {
  return `${cancelToken}:runtime-actions`;
}

/** Keeps cancellation active across runtime-action dispatch and callback waiting. */
export async function runRuntimeActionCancellationScope<
  TDispatch extends RuntimeActionDispatchResult,
  TResult,
>(input: {
  readonly cancel: (targets: readonly RuntimeActionCancellationTarget[]) => Promise<void>;
  readonly cancelToken?: string;
  readonly dispatch: () => Promise<TDispatch>;
  readonly sessionId: string;
  readonly wait: (dispatchResult: TDispatch) => Promise<TResult>;
}): Promise<{
  readonly cancelled: boolean;
  readonly dispatchResult: TDispatch;
  readonly result: TResult;
}> {
  const cancellation =
    input.cancelToken === undefined
      ? undefined
      : createHook<{ readonly kind: "cancel-turn" }>({
          metadata: { sessionId: input.sessionId },
          token: createRuntimeActionCancellationHookToken(input.cancelToken),
        });
  const cancelled = cancellation?.then(() => true as const);

  try {
    const dispatchOperation = input.dispatch();
    const dispatchOutcome = await raceCancellation(dispatchOperation, cancelled);
    const dispatchResult =
      dispatchOutcome.kind === "completed" ? dispatchOutcome.value : await dispatchOperation;
    if (dispatchOutcome.kind === "cancelled") {
      await input.cancel(dispatchResult.cancellationTargets);
    }

    const waitOperation = input.wait(dispatchResult);
    if (dispatchOutcome.kind === "cancelled") {
      return { cancelled: true, dispatchResult, result: await waitOperation };
    }

    const waitOutcome = await raceCancellation(waitOperation, cancelled);
    if (waitOutcome.kind === "cancelled") {
      await input.cancel(dispatchResult.cancellationTargets);
      return { cancelled: true, dispatchResult, result: await waitOperation };
    }

    return { cancelled: false, dispatchResult, result: waitOutcome.value };
  } finally {
    cancellation?.dispose();
  }
}

async function raceCancellation<T>(
  operation: Promise<T>,
  cancelled: Promise<true> | undefined,
): Promise<{ readonly kind: "cancelled" } | { readonly kind: "completed"; readonly value: T }> {
  if (cancelled === undefined) return { kind: "completed", value: await operation };

  return await Promise.race([
    operation.then((value) => ({ kind: "completed" as const, value })),
    cancelled.then(() => ({ kind: "cancelled" as const })),
  ]);
}
