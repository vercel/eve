import {
  getPendingRuntimeActionBatch,
  settleReadyRuntimeActions,
} from "#harness/runtime-actions.js";
import {
  emitRecoverableFailedTurn,
  emitTurnEpilogue,
  getHarnessEmissionState,
  setHarnessEmissionState,
} from "#harness/emission.js";
import type { HarnessEmitFn, HarnessSession } from "#harness/types.js";
import { createMessageCompletedEvent } from "#protocol/message.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";

export async function settlePassThroughRuntimeActionTurn(input: {
  readonly emit: HarnessEmitFn;
  readonly results: readonly RuntimeActionResult[];
  readonly session: HarnessSession;
}): Promise<HarnessSession | undefined> {
  const batch = getPendingRuntimeActionBatch(input.session.state);
  if (batch?.settlement !== "pass-through") return undefined;
  if (batch.actions.length !== 1) {
    throw new Error("Pass-through runtime-action turns require exactly one action.");
  }
  const settled = await settleReadyRuntimeActions(input);
  if (settled === undefined || settled.results.length !== 1) {
    throw new Error("Pass-through runtime action returned no bound result.");
  }
  const result = settled.results[0]!;
  const session = settled.session;
  const emission = getHarnessEmissionState(session.state);
  if (result.isError === true) {
    return setHarnessEmissionState(
      session,
      await emitRecoverableFailedTurn(input.emit, emission, {
        code: "REMOTE_AGENT_FAILED",
        continuationToken: session.continuationToken,
        message: stringify(result.output),
      }),
    );
  }
  await input.emit(
    createMessageCompletedEvent({
      message: stringify(result.output),
      sequence: emission.sequence,
      stepIndex: emission.stepIndex,
      turnId: emission.turnId,
    }),
  );
  return setHarnessEmissionState(
    session,
    await emitTurnEpilogue(input.emit, emission, "conversation"),
  );
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}
