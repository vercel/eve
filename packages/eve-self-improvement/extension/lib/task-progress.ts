import { defineState } from "eve/context";

export const taskProgress = defineState<{
  turnId: string;
  calls: { name: string; state: string }[];
}>("evolution-delegated-calls", () => ({ turnId: "", calls: [] }));

export function delegationPending(
  progress: ReturnType<typeof taskProgress.get>,
  turnId: string,
): boolean {
  return (
    progress.turnId === turnId &&
    progress.calls.some((call) => !["completed", "failed", "interrupted"].includes(call.state))
  );
}

export function delegationCompleted(
  progress: ReturnType<typeof taskProgress.get>,
  turnId: string,
  name: string,
): boolean {
  return (
    progress.turnId === turnId &&
    progress.calls.findLast((call) => call.name === name)?.state === "completed"
  );
}
