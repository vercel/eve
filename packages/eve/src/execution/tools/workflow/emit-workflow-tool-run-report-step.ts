import type {
  WorkflowToolRunAgentStartedMessage,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import {
  publishSessionEvents,
  writeSessionEvent,
  type PublishedSessionEvents,
  type SessionEventTarget,
} from "#execution/publish-session-events.js";
import { createActionPartialEvent, createAgentStartedEvent } from "#protocol/message.js";
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
export async function emitAgentStartedStep(
  input: SessionEventTarget & {
    readonly message: WorkflowToolRunAgentStartedMessage;
  },
): Promise<PublishedSessionEvents> {
  "use step";

  const { from, session } = input.message;
  const event = createAgentStartedEvent({
    callId: from.callId,
    name: session.name,
    parentSessionId: input.sessionState.sessionId,
    remote: session.remote,
    sessionId: session.sessionId,
  });
  return await publishSessionEvents(input, [event]);
}
