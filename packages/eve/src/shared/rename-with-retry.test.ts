import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renameWithTransientBusyRetry } from "#shared/rename-with-retry.js";

const fake = vi.hoisted(() => ({
  failureCode: "EPERM",
  failures: 0,
  renameCalls: [] as Array<{ sourcePath: string; destinationPath: string }>,
}));

vi.mock("node:fs/promises", () => ({
  rename: async (sourcePath: string, destinationPath: string) => {
    fake.renameCalls.push({ sourcePath, destinationPath });
    if (fake.failures > 0) {
      fake.failures -= 1;
      throw Object.assign(new Error(`injected ${fake.failureCode} rename failure`), {
        code: fake.failureCode,
      });
    }
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
});

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const settled = Promise.allSettled([promise]);
  await vi.runAllTimersAsync();
  return (await settled)[0];
}

describe("renameWithTransientBusyRetry", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("retries a transient %s failure", async (code) => {
    fake.failureCode = code;
    fake.failures = 2;

    const result = await settle(renameWithTransientBusyRetry("source", "destination"));

    expect(result.status).toBe("fulfilled");
    expect(fake.renameCalls).toHaveLength(3);
  });

  it("gives up after bounded retries", async () => {
    fake.failures = Number.MAX_SAFE_INTEGER;

    const result = await settle(renameWithTransientBusyRetry("source", "destination"));

    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toMatchObject({ code: "EPERM" });
    expect(fake.renameCalls).toHaveLength(8);
  });

  it("does not retry a permanent rename failure", async () => {
    fake.failureCode = "ENOENT";
    fake.failures = 1;

    const result = await settle(renameWithTransientBusyRetry("source", "destination"));

    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toMatchObject({ code: "ENOENT" });
    expect(fake.renameCalls).toHaveLength(1);
  });
});
