import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { atomicWriteFile } from "#shared/atomic-write-file.js";

const fake = vi.hoisted(() => ({
  failureCode: "EPERM",
  failures: 0,
  renameCalls: [] as Array<{ from: string; to: string }>,
  rmCalls: [] as string[],
  writeCalls: [] as string[],
}));

vi.mock("node:fs/promises", () => ({
  rename: async (from: string, to: string) => {
    fake.renameCalls.push({ from, to });
    if (fake.failures > 0) {
      fake.failures -= 1;
      const error = new Error(
        `${fake.failureCode}: operation not permitted, rename '${from}' -> '${to}'`,
      ) as NodeJS.ErrnoException;
      error.code = fake.failureCode;
      throw error;
    }
  },
  rm: async (path: string) => {
    fake.rmCalls.push(path);
  },
  writeFile: async (path: string) => {
    fake.writeCalls.push(path);
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  fake.failureCode = "EPERM";
  fake.failures = 0;
  fake.renameCalls.length = 0;
  fake.rmCalls.length = 0;
  fake.writeCalls.length = 0;
});

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const settled = Promise.allSettled([promise]);
  await vi.runAllTimersAsync();
  return (await settled)[0];
}

describe("atomicWriteFile", () => {
  it("retries a Windows-style busy replace until it succeeds", async () => {
    fake.failures = 2;

    const result = await settle(atomicWriteFile("/app/owner.json", "journal"));

    expect(result.status).toBe("fulfilled");
    expect(fake.renameCalls).toHaveLength(3);
    expect(fake.renameCalls[0]?.to).toBe("/app/owner.json");
    expect(fake.rmCalls).toEqual([]);
  });

  it("gives up after bounded retries and removes the temp file", async () => {
    fake.failures = Number.MAX_SAFE_INTEGER;

    const result = await settle(atomicWriteFile("/app/owner.json", "journal"));

    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toMatchObject({ code: "EPERM" });
    expect(fake.renameCalls).toHaveLength(8);
    expect(fake.rmCalls).toEqual([fake.renameCalls[0]?.from]);
  });

  it("does not retry failure codes that a repeated rename cannot fix", async () => {
    fake.failureCode = "EISDIR";
    fake.failures = 1;

    const result = await settle(atomicWriteFile("/app/owner.json", "journal"));

    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toMatchObject({ code: "EISDIR" });
    expect(fake.renameCalls).toHaveLength(1);
    expect(fake.rmCalls).toEqual([fake.renameCalls[0]?.from]);
  });
});
