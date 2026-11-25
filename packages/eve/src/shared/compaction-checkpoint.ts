export const COMPACTION_CHECKPOINT_MARKER = "Summary of our conversation so far:";

export function isCheckpointMarker(message: {
  readonly role: string;
  readonly kind?: unknown;
}): boolean {
  return message.role === "user" && message.kind === "context.compaction";
}
