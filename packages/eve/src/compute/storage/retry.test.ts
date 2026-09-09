import { describe, expect, it, vi } from "vitest";

import { runComputeTransaction } from "#compute/storage/retry.js";
import type { ComputeStorage } from "#compute/storage/types.js";

function storageWithFailures(codes: string[]): ComputeStorage {
  return {
    close: async () => {},
    query: vi.fn(),
    transaction: vi.fn(async (operation) => {
      const code = codes.shift();
      if (code !== undefined) throw Object.assign(new Error(code), { code });
      return await operation({ query: vi.fn() });
    }),
  };
}

describe("compute transaction retry", () => {
  it("retries only known rolled-back PostgreSQL transaction failures", async () => {
    const storage = storageWithFailures(["40P01", "40001"]);
    await expect(runComputeTransaction(storage, async () => "done")).resolves.toBe("done");
    expect(storage.transaction).toHaveBeenCalledTimes(3);
  });

  it("does not retry an ambiguous connection failure", async () => {
    const storage = storageWithFailures(["08006"]);
    await expect(runComputeTransaction(storage, async () => "done")).rejects.toMatchObject({
      code: "08006",
    });
    expect(storage.transaction).toHaveBeenCalledTimes(1);
  });
});
