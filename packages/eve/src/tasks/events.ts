import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { createSubagentCalledEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { ChildAddress } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";

// Stream events that project task lifecycle onto the owner's session stream.

export function createCalledEvent(input: {
  readonly child: ChildAddress;
  readonly record: TaskRecord;
  readonly sequence: number;
  readonly sessionId: string;
  readonly toolName: string;
  readonly turnId: string;
}): UnstampedMessageStreamEvent {
  const { child, record } = input;
  return createSubagentCalledEvent({
    agentId: record.id,
    callId: record.callId,
    childSessionId: child.kind === "workflow" ? child.runId : child.sessionId,
    name: record.name,
    remote:
      child.kind === "remote"
        ? { resolverId: child.credentialResolver ?? record.nodeId, url: child.url }
        : undefined,
    sequence: input.sequence,
    sessionId: input.sessionId,
    toolName: input.toolName,
    turnId: input.turnId,
    workflowId: workflowEntryReference.workflowId,
  });
}
