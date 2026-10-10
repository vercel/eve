import { conversationLedger } from "#client/conversation-projection.js";
import type { EveDynamicToolPart, EveMessageData } from "#client/message-reducer-types.js";
import {
  isSettledCallStatus,
  readerInput,
  readerTasks,
  reportedCallStatus,
} from "#protocol/session-reader.js";

/** A tool part's content, whichever state it was written in. */
interface ToolPartContent {
  readonly approval?: { readonly id: string; readonly isAutomatic?: boolean };
  readonly errorText?: string;
  readonly output?: unknown;
  readonly partial?: true;
}

/**
 * A tool part in the state the session projection gives its call. A request a person still has
 * to answer comes first, then the call's own status; a call the projection doesn't know, such as
 * a child's call a relayed request names, keeps the state its events wrote.
 */
export function toolPartState(data: EveMessageData, part: EveDynamicToolPart): EveDynamicToolPart {
  const content = part as ToolPartContent;
  const { responded: sent, view } = conversationLedger(data);
  const call = view.calls[part.toolCallId];
  const status = reportedCallStatus(view, part.toolCallId);
  const requestId = content.approval?.id;
  const shown = requestId === undefined ? undefined : readerInput(view, requestId);
  // An answer this client sent shows until the stream settles it.
  const answer = requestId === undefined ? undefined : sent[requestId];
  const input =
    shown !== undefined && answer !== undefined && shown.status === "open"
      ? { ...shown, response: answer }
      : shown;
  const base = {
    input: part.input,
    stepIndex: part.stepIndex,
    toolCallId: part.toolCallId,
    toolMetadata: part.toolMetadata,
    toolName: part.toolName,
    type: "dynamic-tool" as const,
  };
  const requested =
    requestId === undefined
      ? undefined
      : {
          id: requestId,
          ...(content.approval?.isAutomatic !== undefined && {
            isAutomatic: content.approval.isAutomatic,
          }),
        };
  /** An answered request: approved, or answered without a decision, as a question is. */
  const responded = (approved: boolean, reason: string | undefined): EveDynamicToolPart => ({
    ...base,
    approval: {
      ...requested!,
      ...(approved && { approved: true }),
      ...(reason !== undefined && { reason }),
    },
    state: "approval-responded",
  });
  const approvedTrue =
    requested === undefined ? undefined : { ...requested, approved: true as const };

  // A request still open, or answered by this client before the stream settled it, waits for
  // its answer, unless the call already ended.
  if (
    requested !== undefined &&
    input !== undefined &&
    input.status !== "settled" &&
    (status === undefined || !isSettledCallStatus(status))
  ) {
    return { ...base, approval: requested, state: "approval-requested" };
  }

  const task =
    call?.taskId === undefined ? undefined : readerTasks(view)[call.taskId]?.calls[part.toolCallId];
  if (call === undefined || status === undefined) {
    if (input === undefined) return part;
    return input.response === undefined
      ? { ...base, output: { status: input.outcome }, state: "output-available" }
      : responded(input.outcome === "approved", input.response.text);
  }
  switch (status) {
    case "running":
    case "awaiting-input":
      if (content.partial === true) {
        return {
          ...base,
          approval: approvedTrue,
          output: content.output,
          partial: true,
          state: "output-available",
        };
      }
      if (input !== undefined && (input.outcome === "approved" || input.response !== undefined)) {
        return responded(input.outcome === "approved", input.response?.text);
      }
      return { ...base, state: "input-available" };
    case "completed":
      return {
        ...base,
        approval: approvedTrue,
        output: task?.output ?? content.output,
        state: "output-available",
      };
    case "failed":
      return {
        ...base,
        approval: approvedTrue,
        errorText:
          task?.error?.message ??
          content.errorText ??
          call.error?.message ??
          (call.taskId === undefined ? "Action failed." : "Task failed."),
        state: "output-error",
      };
    case "rejected":
      return {
        ...base,
        approval: {
          id: requestId ?? part.toolCallId,
          approved: false,
          reason: call.error?.message ?? content.errorText,
        },
        state: "output-denied",
      };
    case "cancelled":
      // A withdrawn approval never ran its call; a stopped call or task did.
      if (requestId !== undefined && input?.outcome === "cancelled") {
        return {
          ...base,
          approval: { id: requestId, approved: false, reason: "Tool execution was cancelled." },
          state: "output-denied",
        };
      }
      return {
        ...base,
        approval: approvedTrue,
        errorText:
          call.taskId === undefined
            ? (content.errorText ?? call.error?.message ?? "Action was cancelled.")
            : "Task was cancelled.",
        state: "output-error",
      };
  }
}
