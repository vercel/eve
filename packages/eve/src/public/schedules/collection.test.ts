import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineScheduleCollection,
  type ScheduleProviderContext,
  type ScheduleScopeContext,
} from "#public/schedules/collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { byPrincipal } from "#public/schedules/scope.js";
import { isScheduleCollectionDefinition } from "#shared/schedule-collection-definition.js";

const providerContext = (operationId: string): ScheduleProviderContext => ({
  abortSignal: new AbortController().signal,
  collection: "queries",
  namespace: "principal_1",
  operationId,
  target: { key: "queries" },
});

describe("schedule collections", () => {
  it("brands an exact collection definition without changing its fields", () => {
    const provider = inMemoryScheduleProvider();
    const definition = defineScheduleCollection({
      description: "Run saved queries.",
      inputSchema: z.object({ query: z.string() }),
      provider,
      scope: byPrincipal,
      tools: true,
      run: async ({ input }) => {
        input.query.toUpperCase();
      },
    });

    expect(definition.provider).toBe(provider);
    expect(definition.provider.kind).toBe("in-memory");
    expect(isScheduleCollectionDefinition(definition)).toBe(true);
  });

  it("derives principal scope without enabling anonymous or runtime callers", () => {
    const context = (principalType: string): ScheduleScopeContext => ({
      abortSignal: new AbortController().signal,
      channel: { kind: "eve" },
      session: {
        id: "session_1",
        auth: {
          current: {
            attributes: {},
            authenticator: "test",
            principalId: "principal_1",
            principalType,
          },
          initiator: null,
        },
      },
    });

    expect(byPrincipal(context("anonymous"))).toBeNull();
    expect(byPrincipal(context("runtime"))).toBeNull();
    expect(byPrincipal(context("local-dev"))).toBe("local-dev");
    expect(JSON.parse(byPrincipal(context("user"))!)).toEqual([
      "user",
      "test",
      null,
      "principal_1",
    ]);
  });
});

describe("inMemoryScheduleProvider", () => {
  it("supports scoped lifecycle operations and hides stored input", async () => {
    let timestamp = Date.parse("2026-09-20T12:00:00.000Z");
    const provider = inMemoryScheduleProvider({ now: () => new Date(timestamp) });

    const created = await provider.create(providerContext("create_1"), {
      expression: { type: "cron", cron: " 0   9 * * 0 ", timezone: "UTC" },
      input: { query: "open incidents" },
      name: "weekly-incidents",
    });

    expect(created).toMatchObject({
      expression: { type: "cron", cron: "0 9 * * 0", timezone: "UTC" },
      name: "weekly-incidents",
      state: "active",
    });
    expect(created).not.toHaveProperty("input");
    expect(created.scheduleId).toMatch(/^mem_[0-9a-f]{64}$/u);
    expect(created.scheduleId).not.toContain("principal_1");
    await expect(provider.get(providerContext("get_1"), created.name)).resolves.toEqual(created);

    timestamp += 1_000;
    const disabled = await provider.disable(providerContext("disable_1"), created.name);
    expect(disabled.state).toBe("inactive");
    expect(disabled.updatedAt).toBe(timestamp);

    const updated = await provider.update(providerContext("update_1"), created.name, {
      expression: { type: "single", at: "2026-10-01T09:00:00", timezone: "UTC" },
      input: { query: "failed deployments" },
    });
    expect(updated.expression).toEqual({
      type: "single",
      at: "2026-10-01T09:00:00",
      timezone: "UTC",
    });

    await provider.invoke(providerContext("invoke_1"), created.name);
    await expect(provider.list(providerContext("list_1"), {})).resolves.toMatchObject({
      cursor: null,
      data: [expect.objectContaining({ name: created.name })],
    });
    await expect(provider.delete(providerContext("delete_1"), created.name)).resolves.toBe(true);
    await expect(provider.get(providerContext("get_2"), created.name)).resolves.toBeNull();
  });

  it("does not reveal raw scope keys in public schedule IDs", async () => {
    const provider = inMemoryScheduleProvider();
    const context = {
      ...providerContext("create_private"),
      namespace: "eve-private-user-identity",
    };
    const created = await provider.create(context, {
      expression: { type: "cron", cron: "0 9 * * *" },
      input: { query: "test" },
      name: "reminder",
    });
    expect(created.scheduleId).toMatch(/^mem_[0-9a-f]{64}$/u);
    expect(created.scheduleId).not.toContain(context.namespace);
  });

  it("isolates namespaces and reuses committed operation results", async () => {
    const provider = inMemoryScheduleProvider();
    const firstContext = providerContext("create_1");
    const input = {
      expression: { type: "cron" as const, cron: "0 9 * * 0" },
      input: { query: "open incidents" },
      name: "weekly-incidents",
    };

    const first = await provider.create(firstContext, input);
    const replayed = await provider.create(firstContext, input);
    expect(replayed).toEqual(first);

    const otherNamespace = { ...providerContext("get_other"), namespace: "principal_2" };
    await expect(provider.get(otherNamespace, input.name)).resolves.toBeNull();
  });

  it("delivers an invocation once when an operation is replayed", async () => {
    const delivered: unknown[] = [];
    const provider = inMemoryScheduleProvider({
      now: () => new Date("2026-09-20T12:00:00.000Z"),
    });
    const createContext = {
      ...providerContext("create"),
      target: { key: "queries", deliver: async (value: unknown) => void delivered.push(value) },
    };
    await provider.create(createContext, {
      expression: { type: "cron", cron: "0 9 * * 0" },
      input: { query: "open incidents" },
      name: "weekly-incidents",
    });
    const invokeContext = { ...providerContext("invoke"), target: { key: "queries" } };

    await provider.invoke(invokeContext, "weekly-incidents");
    await provider.invoke(invokeContext, "weekly-incidents");

    expect(delivered).toHaveLength(1);
  });
});
