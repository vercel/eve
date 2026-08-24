import type { RunRef } from "#execution/tool-run/messages.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import {
  createActionPartialEvent,
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
} from "#protocol/message.js";
import type { JsonValue } from "#shared/json.js";

/**
 * Emits one workflow tool run progress report as an `action.partial` snapshot
 * for the run's call. Snapshots are last-write-wins by call id and never enter
 * model history — the same contract as an in-process generator tool's yields.
 */
export async function emitRunReportStep(input: {
  readonly from: RunRef;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly update: JsonValue;
}): Promise<void> {
  "use step";

  const event = createActionPartialEvent({
    result: createRuntimeToolResultFromValue({
      callId: input.from.callId,
      output: input.update,
      toolName: input.from.toolName,
    }),
    sequence: 0,
    stepIndex: input.from.stepIndex,
    turnId: input.from.turnId,
  });
  const writer = input.parentWritable.getWriter();
  try {
    await writer.write(encodeMessageStreamEvent(stampMessageStreamEvent(event)));
  } finally {
    writer.releaseLock();
  }
}
