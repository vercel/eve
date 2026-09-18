import { describe, expect, it } from "vitest";
import { mapConcurrent } from "#shared/map-concurrent.js";

describe("mapConcurrent", () => {
  it("bounds in-flight work and retains input order", async () => {
    let active = 0;
    let maximum = 0;
    const result = await mapConcurrent(
      [3, 2, 1, 0],
      async (value) => {
        maximum = Math.max(maximum, ++active);
        for (let i = 0; i < value; i++) await Promise.resolve();
        active--;
        return value * 2;
      },
      2,
    );
    expect(result).toEqual([6, 4, 2, 0]);
    expect(maximum).toBe(2);
    expect(active).toBe(0);
  });

  it("drains started work before rejecting and stops scheduling", async () => {
    const running = Promise.withResolvers<void>();
    const started: number[] = [];
    const error = new Error("failed");
    let settled = false;
    const result = mapConcurrent(
      [0, 1, 2],
      async (value) => {
        started.push(value);
        if (value === 0) throw error;
        await running.promise;
        return value;
      },
      2,
    );
    const observed = result.catch((failure) => {
      settled = true;
      return failure;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(started).toEqual([0, 1]);
    running.resolve();
    expect(await observed).toBe(error);
  });

  it("handles empty inputs and rejects invalid concurrency", async () => {
    expect(await mapConcurrent([], async () => 1)).toEqual([]);
    await expect(mapConcurrent([], async () => 1, 0)).rejects.toThrow();
    await expect(mapConcurrent([], async () => 1, 1.5)).rejects.toThrow();
  });
});
