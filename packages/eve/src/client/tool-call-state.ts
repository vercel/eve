import { conversationView } from "#client/conversation-projection.js";
import type { ConversationState } from "#client/conversation-state.js";
import type { EveDynamicToolPart } from "#client/message-reducer-types.js";
import { callStatus, type SessionCallStatus } from "#protocol/session-reader.js";

/**
 * Where a tool call stands. `interrupted` is a call still running when its turn ended without an
 * outcome, or when the reader's stream stopped; `cancelled` follows task or input cancellation.
 */
export type ToolCallStatus = SessionCallStatus | "interrupted";

export interface ToolCallState {
  readonly status: ToolCallStatus;
  /** The call's output, or its latest partial output while it runs. */
  readonly output?: unknown;
  readonly errorText?: string;
  /** A reported execution error code, when available. */
  readonly errorCode?: string;
}

/**
 * A tool call's state for rendering: its status from the session projection, which every reader
 * shares, and its content from the message part. Pass `streaming: false` once the reader's stream
 * stopped, so a call left running reads as interrupted.
 */
export function toolCallState(
  conversation: ConversationState,
  callId: string,
  options: { readonly streaming?: boolean } = {},
): ToolCallState | undefined {
  const part = findToolPart(conversation, callId);
  const view = conversationView(conversation);
  const call = view.calls[callId];
  const status = callStatus(view, callId, options) ?? partStatus(part, options);
  if (status === undefined) return undefined;
  const task = call?.taskId === undefined ? undefined : conversation.tasks[call.taskId];
  const taskCall = task?.calls[callId];
  const output = taskCall?.output ?? part?.output;
  const errorText =
    taskCall?.error?.message ??
    part?.errorText ??
    call?.error?.message ??
    (part?.state === "output-denied" ? part.approval.reason : undefined);
  const state: { -readonly [K in keyof ToolCallState]: ToolCallState[K] } = {
    status: respondedStatus(conversation, part, status),
  };
  if (output !== undefined) state.output = output;
  if (errorText !== undefined) state.errorText = errorText;
  if (call?.error?.code !== undefined) state.errorCode = call.error.code;
  return state;
}

/** An approval this client answered reads as decided until the stream settles it. */
function respondedStatus(
  conversation: ConversationState,
  part: EveDynamicToolPart | undefined,
  status: ToolCallStatus,
): ToolCallStatus {
  if (status !== "awaiting-input" || part?.state !== "approval-requested") return status;
  const input = conversation.inputs[part.approval.id];
  if (input?.status !== "responded") return status;
  return input.response?.optionId === "approve" ? "running" : "rejected";
}

/** A part the stream hasn't announced as a call yet, such as one whose input still streams. */
function partStatus(
  part: EveDynamicToolPart | undefined,
  options: { readonly streaming?: boolean },
): ToolCallStatus | undefined {
  if (part === undefined) return undefined;
  switch (part.state) {
    case "output-available":
      return part.partial === true ? "running" : "completed";
    case "output-error":
      return "failed";
    case "output-denied":
      return "rejected";
    case "approval-requested":
      return "awaiting-input";
    default:
      return options.streaming === false ? "interrupted" : "running";
  }
}

function findToolPart(
  conversation: ConversationState,
  callId: string,
): EveDynamicToolPart | undefined {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    for (const part of conversation.messages[index]!.parts) {
      if (part.type === "dynamic-tool" && part.toolCallId === callId) return part;
    }
  }
  return undefined;
}
