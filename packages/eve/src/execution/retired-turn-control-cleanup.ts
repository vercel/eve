type AsyncOutcome<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly reason: unknown; readonly status: "rejected" };

/** Overlaps one retired turn-control cleanup with the next turn's settlement. */
export class RetiredTurnControlCleanup {
  private outcome: Promise<AsyncOutcome<void>> | undefined;

  begin(dispose: () => Promise<void>): void {
    this.outcome = captureAsyncOutcome(dispose());
  }

  async join<T>(settlement: Promise<T>): Promise<T> {
    const cleanup = this.outcome;
    this.outcome = undefined;
    if (cleanup === undefined) return await settlement;

    const [cleanupOutcome, settlementOutcome] = await Promise.all([
      cleanup,
      captureAsyncOutcome(settlement),
    ]);
    // Cleanup ran first before this overlap, so its failure remains
    // authoritative when both operations fail.
    if (cleanupOutcome.status === "rejected") throw cleanupOutcome.reason;
    if (settlementOutcome.status === "rejected") throw settlementOutcome.reason;
    return settlementOutcome.value;
  }
}

async function captureAsyncOutcome<T>(promise: Promise<T>): Promise<AsyncOutcome<T>> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { reason, status: "rejected" };
  }
}
