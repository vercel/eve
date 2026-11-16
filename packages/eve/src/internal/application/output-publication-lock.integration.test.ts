import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireRecoveryLease } from "#internal/application/output-publication-lock.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

const fileSystemFaults = vi.hoisted(() => ({
  mkdir: undefined as
    | ((path: string, options: unknown) => Promise<Error | undefined> | undefined)
    | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    async mkdir(...input: Parameters<typeof original.mkdir>) {
      const error = await fileSystemFaults.mkdir?.(String(input[0]), input[1]);
      if (error !== undefined) {
        throw error;
      }
      return original.mkdir(...input);
    },
  };
});

afterEach(() => {
  fileSystemFaults.mkdir = undefined;
});

describe("acquireRecoveryLease", () => {
  it("reports contention when the holder releases the lock during a recursive mkdir", async () => {
    const root = await createScratchDirectory("eve-recovery-lease-");
    const lockPath = join(root, "sandbox-preparation.lock");
    const holder = await acquireRecoveryLease(lockPath, "holder");
    expect(holder).toBeDefined();

    // Recursive mkdir sees EEXIST, then stats a lock that its holder renamed away in between.
    fileSystemFaults.mkdir = async (path, options) => {
      if (path !== lockPath || (options as { recursive?: boolean })?.recursive !== true) return;
      fileSystemFaults.mkdir = undefined;
      await holder!.complete();
      return Object.assign(new Error(`ENOENT: no such file or directory, mkdir '${path}'`), {
        code: "ENOENT",
      });
    };
    await expect(acquireRecoveryLease(lockPath, "waiter")).resolves.toBeUndefined();

    const waiter = await acquireRecoveryLease(lockPath, "waiter");
    expect(waiter).toBeDefined();
    await waiter!.complete();
    expect(await readdir(root)).toEqual([]);
  });
});
