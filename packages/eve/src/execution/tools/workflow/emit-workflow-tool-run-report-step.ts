import type {
  WorkflowToolRunAgentStartedMessage,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import {
  createActionPartialEvent,
  createAgentStartedEvent,
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { JsonValue } from "#shared/json.js";

export async function emitWorkflowToolRunReportStep(input: {
  readonly from: WorkflowToolRunRef;
  readonly sessionWritable: WritableStream<Uint8Array>;
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
  await writeSessionEvent(input.sessionWritable, event);
}

/** Publishes `agent.started` for a session a workflow tool run opened. */
export async function emitAgentStartedStep(input: {
  readonly message: WorkflowToolRunAgentStartedMessage;
  readonly parentSessionId: string;
  readonly sessionWritable: WritableStream<Uint8Array>;
}): Promise<void> {
  "use step";

  const { from, session } = input.message;
  const event = createAgentStartedEvent({
    callId: from.callId,
    name: session.name,
    parentSessionId: input.parentSessionId,
    remote: session.remote,
    sessionId: session.sessionId,
  });
  await writeSessionEvent(input.sessionWritable, event);
}

/** Writes one event straight to the session stream; call from a step. */
export async function writeSessionEvent(
  sessionWritable: WritableStream<Uint8Array>,
  event: UnstampedMessageStreamEvent,
): Promise<void> {
  const writer = sessionWritable.getWriter();
  try {
    await writer.write(encodeMessageStreamEvent(stampMessageStreamEvent(event)));
  } finally {
    writer.releaseLock();
  }
}
