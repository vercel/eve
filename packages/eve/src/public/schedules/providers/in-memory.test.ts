import { describe, expect, it, vi } from "vitest";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import type { ScheduleProviderContext } from "#runtime/schedules/provider-types.js";

const context = (
  operationId: string,
  target: ScheduleProviderContext["target"] = { key: "app" },
): ScheduleProviderContext => ({
  abortSignal: new AbortController().signal,
  collection: "tasks",
  namespace: "namespace",
  operationId,
  target,
});

describe("inMemoryScheduleProvider", () => {
  it("executes manual invocations with unique schedule and occurrence identities", async () => {
    const deliveries: unknown[] = [];
    let now = Date.parse("2026-09-28T12:00:00.000Z");
    const provider = inMemoryScheduleProvider({ now: () => new Date(now++) });
    const deliver = vi.fn(async (delivery: unknown) => {
      deliveries.push(delivery);
    });
    await provider.create(context("create", { key: "app", deliver }), {
      name: "daily",
      expression: { type: "cron", cron: "0 9 * * *" },
      payload: { request: "do work" },
    });
    await provider.invoke(context("invoke-1"), "daily");
    await provider.invoke(context("invoke-2"), "daily");
    expect(deliveries).toHaveLength(2);
    const [first, second] = deliveries as Array<{
      occurrence: { scheduleId: string; executionId: string };
      payload: unknown;
    }>;
    expect(first!.occurrence.scheduleId).not.toContain("daily");
    expect(first!.occurrence.scheduleId).toBe(second!.occurrence.scheduleId);
    expect(first!.occurrence.executionId).not.toBe(second!.occurrence.executionId);
    expect(first!.payload).toEqual({ request: "do work" });
  });

  it("redelivers the same occurrence when its operation is retried", async () => {
    const deliveries: unknown[] = [];
    const provider = inMemoryScheduleProvider();
    const deliver = async (delivery: unknown) => {
      deliveries.push(delivery);
    };
    await provider.create(context("create", { key: "app", deliver }), {
      name: "weekly",
      expression: { type: "cron", cron: "0 9 * * 1" },
      payload: { request: "do work" },
    });
    await provider.invoke(context("invoke-1"), "weekly");
    await provider.invoke(context("invoke-2", { key: "app", deliver }), "weekly");
    await provider.invoke(context("invoke-2", { key: "app", deliver }), "weekly");
    expect(deliveries).toHaveLength(3);
    expect(deliveries[1]).toEqual(deliveries[2]);
  });

  it("does not reuse a schedule ID after deleting and recreating the same name", async () => {
    const provider = inMemoryScheduleProvider();
    const createContext = context("create-1");
    const input = {
      name: "daily",
      expression: { type: "cron" as const, cron: "0 9 * * *" },
      payload: {},
    };
    const first = await provider.create(createContext, input);
    await provider.delete(context("delete"), "daily");
    const recreated = await provider.create(context("create-2"), input);
    expect(recreated.scheduleId).not.toBe(first.scheduleId);
  });
});
