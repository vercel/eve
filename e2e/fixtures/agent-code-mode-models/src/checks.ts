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
    reads.every((call) =>
      cursors.includes((call.input as { cursor?: string | null }).cursor ?? null),
    ) &&
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
  const reads: Call[] = [];
  for (const id of accountIds) {
    const first = calls
      .filter(
        (call) =>
          call.tool === "balances" && (call.input as { accountId: string }).accountId === id,
      )
      .sort((a, b) => a.started - b.started)[0];
    if (!first || first.status !== (id === unavailableId ? "failed" : "completed")) return false;
    reads.push(first);
  }
  if (reads.length === 0) return false;
  return (
    Math.max(...reads.map((call) => call.started)) <
    Math.min(...reads.map((call) => call.finished ?? Number.NEGATIVE_INFINITY))
  );
}
