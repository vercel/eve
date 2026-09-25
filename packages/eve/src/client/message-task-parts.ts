import type {
  EveDynamicToolPart,
  EveMessage,
  EveMessageData,
  EveMessageToolTask,
} from "#client/message-reducer-types.js";
import { upsertMessage } from "#client/message-reducer-primitives.js";
import type {
  TaskEndedStreamEvent,
  TaskSettledStreamEvent,
  TaskStartedStreamEvent,
} from "#protocol/message.js";

/**
 * Projects a task's lifecycle onto the tool part of the call that started
 * each generation. A part keeps the latest generation it started, so a
 * repeated or late boundary for an earlier generation changes nothing, and
 * a call with no part, such as a workflow body's `ctx.agent`, is skipped.
 * Models may reuse a call ID in a later turn, so a start matches only parts
 * of its own turn's messages; later events follow the task the part took.
 */
export function reduceTaskEvent(
  data: EveMessageData,
  event: TaskStartedStreamEvent | TaskSettledStreamEvent | TaskEndedStreamEvent,
): EveMessageData {
  switch (event.type) {
    case "task.started": {
      const { callId, generation, taskId, turnId } = event.data;
      return updateTaskParts(
        data,
        (part, message) =>
          part.toolCallId === callId &&
          (message.metadata?.turnId === undefined || message.metadata.turnId === turnId) &&
          (taskOf(part)?.generation ?? 0) < generation,
        () => ({ generation, id: taskId, status: "working" }),
      );
    }
    case "task.settled": {
      const { callId, generation, status, taskId } = event.data;
      return updateTaskParts(
        data,
        (part) =>
          part.toolCallId === callId &&
          taskOf(part)?.id === taskId &&
          taskOf(part)?.generation === generation,
        (task) => ({ ...task!, status }),
      );
    }
    case "task.ended":
      return updateTaskParts(
        data,
        (part) => taskOf(part)?.id === event.data.taskId,
        (task) => ({ ...task!, ended: true }),
      );
  }
}

function taskOf(part: EveDynamicToolPart): EveMessageToolTask | undefined {
  return part.toolMetadata?.eve?.task;
}

function updateTaskParts(
  data: EveMessageData,
  matches: (part: EveDynamicToolPart, message: EveMessage) => boolean,
  update: (task: EveMessageToolTask | undefined) => EveMessageToolTask,
): EveMessageData {
  let next = data;
  for (const message of data.messages) {
    if (!message.parts.some((part) => part.type === "dynamic-tool" && matches(part, message))) {
      continue;
    }
    next = upsertMessage(next, {
      ...message,
      parts: message.parts.map((part) =>
        part.type === "dynamic-tool" && matches(part, message)
          ? {
              ...part,
              toolMetadata: {
                eve: {
                  kind: "unknown",
                  name: part.toolName,
                  ...part.toolMetadata?.eve,
                  task: update(taskOf(part)),
                },
              },
            }
          : part,
      ),
    });
  }
  return next;
}
