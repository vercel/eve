import type { ModelMessage } from "ai";

import type { WorkflowHistory } from "#shared/history-message.js";

export type {
  HistoryBinaryData,
  HistoryContentPart,
  HistoryCustomPart,
  HistoryFileData,
  HistoryFilePart,
  HistoryImagePart,
  HistoryMessage,
  HistoryProviderReference,
  HistoryReasoningPart,
  HistoryTextPart,
  HistoryToolApprovalRequestPart,
  HistoryToolApprovalResponsePart,
  HistoryToolCallPart,
  HistoryToolResultPart,
  WorkflowHistory,
} from "#shared/history-message.js";

/** Copies supported rich values without retaining mutable session references. */
export function copyWorkflowHistory(
  history: readonly ModelMessage[] | WorkflowHistory,
): WorkflowHistory {
  return copyValue(history) as WorkflowHistory;
}

export function toModelMessages(history: WorkflowHistory): ModelMessage[] {
  return copyValue(history) as ModelMessage[];
}

function copyValue(value: unknown): unknown {
  if (value instanceof URL) return new URL(value.href);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (Array.isArray(value)) return Object.freeze(value.map(copyValue));
  if (isPlainRecord(value)) {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyValue(child)])),
    );
  }
  return value;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
