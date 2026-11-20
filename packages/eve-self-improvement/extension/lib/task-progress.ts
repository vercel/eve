import { defineState } from "eve/context";

export const taskProgress = defineState<{
  turnId: string;
  calls: { name: string; state: string; output?: string }[];
}>("evolution-delegated-calls", () => ({ turnId: "", calls: [] }));

export function delegationPending(
  progress: ReturnType<typeof taskProgress.get>,
  turnId: string,
): boolean {
  return (
    progress.turnId === turnId &&
    progress.calls.some(
      (call) => !["completed", "failed", "rejected", "cancelled"].includes(call.state),
    )
  );
}
