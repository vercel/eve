/** Optional text shown before a tool's approval prompt by supporting clients. */
export interface ToolApprovalContent {
  readonly text: string;
  readonly type: "text";
}

/** A `user-approval` status carrying optional review content. */
export interface ToolApprovalStatusWithContent {
  readonly content: ToolApprovalContent;
  readonly reason?: never;
  readonly type: "user-approval";
}
