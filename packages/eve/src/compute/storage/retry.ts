import { setTimeout as sleep } from "node:timers/promises";

import type { ComputeQueryExecutor, ComputeStorage } from "#compute/storage/types.js";

const RETRYABLE_TRANSACTION_CODES = new Set(["40001", "40P01"]);

function isRetryableTransactionError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    RETRYABLE_TRANSACTION_CODES.has(error.code)
  );
}

export async function runComputeTransaction<T>(
  storage: ComputeStorage,
  operation: (transaction: ComputeQueryExecutor) => Promise<T>,
  maximumAttempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await storage.transaction(operation);
    } catch (error) {
      if (attempt >= maximumAttempts || !isRetryableTransactionError(error)) {
        throw error;
      }
      await sleep(Math.floor(Math.random() * 10 * 2 ** (attempt - 1)));
    }
  }
}
