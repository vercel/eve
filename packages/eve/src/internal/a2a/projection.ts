import type { AgentInvocation } from "#internal/invocation/agent-invocation.js";
import type { A2AMessage, A2APart, A2ATask, A2ATaskState } from "#internal/a2a/protocol.js";
import { A2AError } from "#internal/a2a/protocol.js";
import { inputResponseSchema, type InputResponse } from "#shared/input.js";
import type { JsonValue } from "#shared/json.js";

const states: Record<AgentInvocation["status"], A2ATaskState> = {
  working: "TASK_STATE_WORKING",
  input_required: "TASK_STATE_INPUT_REQUIRED",
  authorization_required: "TASK_STATE_AUTH_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED",
  cancelled: "TASK_STATE_CANCELED",
};
export function resultPart(value: JsonValue): A2APart {
  return typeof value === "string"
    ? { text: value }
    : { data: value, mediaType: "application/json" };
}
export function projectInvocation(invocation: AgentInvocation): A2ATask {
  const task: A2ATask = {
    id: invocation.invocationId,
    contextId: invocation.invocationId,
    status: {
      state: states[invocation.status],
      timestamp: invocation.updatedAt ?? invocation.createdAt,
    },
  };
  const parts: A2APart[] = [];
  if (invocation.status === "input_required") {
    const requests = Object.values(invocation.inputRequests).map(
      ({ requestId, prompt, options, allowFreeform, display, kind }) => {
        const request: Record<string, JsonValue> = { requestId, prompt, kind };
        if (options !== undefined) request.options = options;
        if (allowFreeform !== undefined) request.allowFreeform = allowFreeform;
        if (display !== undefined) request.display = display;
        return request;
      },
    );
    parts.push(
      { text: requests.map((request) => request.prompt).join("\n") },
      { data: { inputRequests: requests } },
    );
  } else if (invocation.status === "authorization_required") {
    // Authorization callback capabilities and provider state stay inside eve.
    parts.push({
      text: invocation.authorizations.map((request) => request.description).join("\n"),
    });
  } else if (invocation.status === "failed") {
    parts.push({ text: "The agent could not complete this task." });
  }
  if (parts.length > 0)
    task.status.message = {
      messageId: `${task.id}:${task.status.state}`,
      role: "ROLE_AGENT",
      taskId: task.id,
      contextId: task.contextId,
      parts,
    };
  if (invocation.status === "completed" && invocation.result !== undefined) {
    task.artifacts = [
      { artifactId: `${task.id}:result`, name: "Result", parts: [resultPart(invocation.result)] },
    ];
  }
  return task;
}
export function messageText(message: A2AMessage): string {
  if (message.role !== "ROLE_USER") throw new A2AError(-32602, "Messages must use ROLE_USER.");
  if (message.parts.some((part) => part.raw !== undefined))
    throw new A2AError(-32005, "Raw file parts are not supported. Send a URL instead.");
  return message.parts
    .map((part) => part.text ?? part.url ?? `\`\`\`json\n${JSON.stringify(part.data)}\n\`\`\``)
    .join("\n");
}
export function inputResponses(
  message: A2AMessage,
  invocation: AgentInvocation,
): readonly InputResponse[] {
  for (const part of message.parts) {
    const data = part.data;
    if (
      data !== null &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      "inputResponses" in data
    ) {
      const parsed = inputResponseSchema.array().safeParse(data.inputResponses);
      if (!parsed.success) throw new A2AError(-32602, "Invalid inputResponses.");
      return parsed.data;
    }
  }
  if (invocation.status !== "input_required")
    throw new A2AError(-32004, "This task is not waiting for input.");
  const requests = Object.values(invocation.inputRequests);
  const request = requests[0];
  if (requests.length !== 1 || request === undefined)
    throw new A2AError(
      -32602,
      "Answer the pending requests with a data part containing inputResponses.",
    );
  const text = messageText(message);
  const option = request.options?.find((option) => option.id === text || option.label === text);
  if (option !== undefined) return [{ requestId: request.requestId, optionId: option.id }];
  if (request.allowFreeform === false)
    throw new A2AError(-32602, "Answer with one of the offered option IDs.");
  return [{ requestId: request.requestId, text }];
}
