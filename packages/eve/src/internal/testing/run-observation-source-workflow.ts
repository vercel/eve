import { getWorkflowMetadata, getWritable, sleep } from "#compiled/@workflow/core/index.js";
import {
  createAgentStartedEvent,
  createSessionCompletedEvent,
  createTaskSettledEvent,
  createTaskStartedEvent,
  createTurnStartedEvent,
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

/** Emits a terminal parent stream before a direct child publishes its late page. */
export async function runObservationSourceWorkflow(input: {
  readonly childSessionId?: string;
  readonly malformedAfterFirst?: boolean;
}): Promise<void> {
  "use workflow";
  const writable = getWritable<Uint8Array>();
  if (input.malformedAfterFirst) {
    await emitMalformedObservationSource(writable);
    return;
  }
  if (input.childSessionId === undefined) {
    await sleep("1500ms");
    await emitObservationSourceEvents(writable, [
      createTurnStartedEvent({ sequence: 0, turnId: "child-turn" }),
    ]);
    return;
  }
  const parentSessionId = getWorkflowMetadata().workflowRunId;
  await emitObservationSourceEvents(writable, [
    createTurnStartedEvent({ sequence: 0, turnId: "root-turn" }),
    createTaskStartedEvent({
      callId: "call",
      kind: "agent",
      name: "research",
      taskId: "task",
      turnId: "root-turn",
    }),
    createAgentStartedEvent({
      callId: "call",
      name: "research",
      parentSessionId,
      sessionId: input.childSessionId,
      taskId: "task",
      turnId: "root-turn",
    }),
    createTaskSettledEvent({
      callId: "call",
      status: "completed",
      taskId: "task",
      turnId: "root-turn",
    }),
    createSessionCompletedEvent(),
  ]);
}

async function emitMalformedObservationSource(writable: WritableStream<Uint8Array>): Promise<void> {
  "use step";
  const writer = writable.getWriter();
  try {
    await writer.write(
      encodeMessageStreamEvent(
        stampMessageStreamEvent(createTurnStartedEvent({ sequence: 0, turnId: "child-turn" })),
      ),
    );
    await writer.write(new TextEncoder().encode('{"type":'));
  } finally {
    writer.releaseLock();
  }
}

async function emitObservationSourceEvents(
  writable: WritableStream<Uint8Array>,
  events: readonly UnstampedMessageStreamEvent[],
): Promise<void> {
  "use step";
  const writer = writable.getWriter();
  try {
    for (const event of events) {
      await writer.write(encodeMessageStreamEvent(stampMessageStreamEvent(event)));
    }
  } finally {
    writer.releaseLock();
  }
}
