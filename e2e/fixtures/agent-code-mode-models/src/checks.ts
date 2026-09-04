import type { Call } from "./audit.ts";

export function inOneProgram(calls: readonly Call[], completedPrograms: readonly string[]) {
  return (
    calls.length > 0 &&
    completedPrograms.some((id) => calls.every((call) => call.callId.startsWith(`${id}:tool-`)))
  );
}

export function readEveryPage(calls: readonly Call[], cursors: readonly (string | null)[]) {
  const reads = calls.filter((call) => call.tool === "orders");
  return (
    reads.length === cursors.length &&
    cursors.every((cursor) =>
      reads.some(
        (call) =>
          call.status === "completed" &&
          ((call.input as { cursor?: string | null }).cursor ?? null) === cursor,
      ),
    )
  );
}

export function concurrentBalances(
  calls: readonly Call[],
  accountIds: readonly string[],
  unavailableId: string,
) {
  const reads = calls.filter((call) => call.tool === "balances");
  if (
    reads.length !== accountIds.length ||
    !accountIds.every((id) =>
      reads.some(
        (call) =>
          (call.input as { accountId: string }).accountId === id &&
          call.status === (id === unavailableId ? "failed" : "completed"),
      ),
    )
  )
    return false;
  return (
    Math.max(...reads.map((call) => call.started)) <
    Math.min(...reads.map((call) => call.finished ?? Number.NEGATIVE_INFINITY))
  );
}
