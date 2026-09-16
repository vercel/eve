/** Fixed acknowledgement returned when a background task is admitted. */
export interface TaskReceipt {
  readonly status: "working";
  readonly taskId: string;
}
