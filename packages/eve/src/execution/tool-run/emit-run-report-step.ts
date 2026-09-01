import type { RunRef } from "#execution/tool-run/messages.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import {
  createActionPartialEvent,
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
} from "#protocol/message.js";
import type { JsonValue } from "#shared/json.js";

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
    sequence: input.from.sequence,
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
