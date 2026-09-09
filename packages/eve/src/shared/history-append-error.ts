export type HistoryAppendErrorCode =
  | "conflict"
  | "invalid_input"
  | "not_owner"
  | "session_busy"
  | "unsupported_execution";

export class WorkflowHistoryAppendError extends Error {
  readonly code: HistoryAppendErrorCode;

  constructor(code: HistoryAppendErrorCode, message: string) {
    super(message);
    this.name = "WorkflowHistoryAppendError";
    this.code = code;
  }
}
