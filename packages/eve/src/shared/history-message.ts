import type { JsonObject, JsonValue } from "#shared/json.js";

interface HistoryPartBase {
  readonly providerOptions?: Readonly<Record<string, JsonObject>>;
}

export interface HistoryTextPart extends HistoryPartBase {
  readonly text: string;
  readonly type: "text";
}

export interface HistoryReasoningPart extends HistoryPartBase {
  readonly text: string;
  readonly type: "reasoning";
}

export type HistoryProviderReference = Readonly<Record<string, string>>;
export type HistoryBinaryData = string | Uint8Array | ArrayBuffer;
export type HistoryFileData =
  | HistoryBinaryData
  | URL
  | HistoryProviderReference
  | { readonly data: HistoryBinaryData; readonly type: "data" }
  | { readonly reference: HistoryProviderReference; readonly type: "reference" }
  | { readonly text: string; readonly type: "text" }
  | { readonly type: "url"; readonly url: string | URL };

export interface HistoryImagePart extends HistoryPartBase {
  readonly image: HistoryBinaryData | URL | HistoryProviderReference;
  readonly mediaType?: string;
  readonly type: "image";
}

export interface HistoryFilePart extends HistoryPartBase {
  readonly data: HistoryFileData;
  readonly filename?: string;
  readonly mediaType: string;
  readonly type: "file" | "reasoning-file";
}

export interface HistoryToolCallPart extends HistoryPartBase {
  readonly input: JsonValue;
  readonly providerExecuted?: boolean;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly type: "tool-call";
}

export interface HistoryToolResultPart extends HistoryPartBase {
  readonly output: JsonValue;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly type: "tool-result";
}

export interface HistoryToolApprovalRequestPart {
  readonly approvalId: string;
  readonly isAutomatic?: boolean;
  readonly toolCallId: string;
  readonly type: "tool-approval-request";
}

export interface HistoryToolApprovalResponsePart {
  readonly approvalId: string;
  readonly approved: boolean;
  readonly reason?: string;
  readonly type: "tool-approval-response";
}

export interface HistoryCustomPart extends HistoryPartBase {
  readonly kind: `${string}.${string}`;
  readonly type: "custom";
}

export type HistoryContentPart =
  | HistoryCustomPart
  | HistoryFilePart
  | HistoryImagePart
  | HistoryReasoningPart
  | HistoryTextPart
  | HistoryToolApprovalRequestPart
  | HistoryToolApprovalResponsePart
  | HistoryToolCallPart
  | HistoryToolResultPart;

/** eve-owned model-history value accepted by privileged session operations. */
export interface HistoryMessage {
  readonly role: "assistant" | "tool" | "user";
  readonly content: string | readonly HistoryContentPart[];
  readonly providerOptions?: Readonly<Record<string, JsonObject>>;
}

/** Immutable-by-value conversation prefix supplied to a workflow tool. */
export type WorkflowHistory = readonly HistoryMessage[];
