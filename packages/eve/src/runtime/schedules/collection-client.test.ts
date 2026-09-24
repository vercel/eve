import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ScheduleDispatcher } from "#channel/schedule.js";
import type { Runtime } from "#channel/types.js";
import { defineScheduleCollection } from "#public/schedules/collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { byPrincipal } from "#public/schedules/scope.js";
import {
  bindScheduleCollection,
  createScheduleScopeContext,
} from "#runtime/schedules/collection-client.js";

const runtime: Runtime = {
  createSession: vi.fn(),
  dispatchContinuation: vi.fn(),
  dispatchSession: vi.fn(),
  getEventStream: vi.fn(),
  getStreamTailIndex: vi.fn(),
  resolveContinuation: vi.fn(),
};

function binding(principalId: string, operationIds: string[]) {
  let index = 0;
  return {
    application: "v-agent",
    ...createScheduleScopeContext({
      abortSignal: new AbortController().signal,
      auth: {
        current: {
          attributes: {},
          authenticator: "test",
          principalId,
          principalType: "user",
        },
        initiator: null,
      },
      sessionId: `session_${principalId}`,
    }),
    operationId: () => operationIds[index++] ?? `operation_${index}`,
  };
}

describe("bindScheduleCollection", () => {
  it("binds scope, validates input, and dispatches an in-memory occurrence", async () => {
    const runs: unknown[] = [];
    const definition = defineScheduleCollection({
      payloadSchema: z.object({ query: z.string().trim().min(1) }),
      provider: inMemoryScheduleProvider({
        now: () => new Date("2026-09-20T12:00:00.000Z"),
      }),
      run({ payload, occurrence }) {
        runs.push({ payload, occurrence });
      },
      scope: byPrincipal,
      tools: false,
    });
    const dispatcher = new ScheduleDispatcher({ runtime, channels: [] });
    const client = await bindScheduleCollection(
      "queries",
      definition,
      binding("alice", ["create", "invoke"]),
      async (delivery) => {
        const validation = await definition.payloadSchema["~standard"].validate(delivery.payload);
        if (validation.issues !== undefined) throw new Error("Invalid scheduled input.");
        await dispatcher.triggerCollection({
          collectionId: "queries",
          payload: validation.value,
          occurrence: delivery.occurrence,
          run: definition.run,
        });
      },
    );

    await client!.create({
      expression: { type: "cron", cron: " 0  9 * * 0 ", timezone: "UTC" },
      payload: { query: " open incidents " },
      name: "weekly-incidents",
    });
    await client!.invoke("weekly-incidents");

    expect(runs).toEqual([
      {
        payload: { query: "open incidents" },
        occurrence: expect.objectContaining({
          scheduledAt: "2026-09-20T12:00:00.000Z",
          name: "weekly-incidents",
        }),
      },
    ]);
  });

  it("resolves typed input from trusted channel context before create and update", async () => {
    const deliveries: unknown[] = [];
    const resolvePayload = vi.fn(
      (
        payload: { message: string; destination: string },
        context: { channel: { metadata?: Readonly<Record<string, unknown>> } },
      ) => ({
        ...payload,
        destination: String(context.channel.metadata?.channelId),
      }),
    );
    const definition = defineScheduleCollection({
      payloadSchema: z.object({ message: z.string().min(1), destination: z.string() }),
      provider: inMemoryScheduleProvider(),
      resolvePayload,
      run() {},
      scope: "fixture",
    });
    const client = await bindScheduleCollection(
      "reminders",
      definition,
      {
        ...binding("alice", ["create", "update", "invoke"]),
        channel: { kind: "slack", metadata: { channelId: "C0123" } },
      },
      async (delivery) => {
        deliveries.push(delivery.payload);
      },
    );
    await client!.create({
      expression: { type: "cron", cron: "0 9 * * *" },
      payload: { message: "First", destination: "here" },
      name: "reminder",
    });
    await client!.update("reminder", { payload: { message: "Second", destination: "here" } });
    await client!.invoke("reminder");
    expect(resolvePayload).toHaveBeenCalledTimes(2);
    expect(resolvePayload).toHaveBeenCalledWith(
      { message: "First", destination: "here" },
      expect.objectContaining({
        auth: expect.objectContaining({
          current: expect.objectContaining({ principalId: "alice" }),
        }),
        channel: { kind: "slack", metadata: { channelId: "C0123" } },
      }),
    );
    expect(deliveries).toEqual([{ message: "Second", destination: "C0123" }]);
  });

  it("isolates principals and returns null for disabled scope", async () => {
    const provider = inMemoryScheduleProvider();
    const definition = defineScheduleCollection({
      payloadSchema: z.object({ query: z.string() }),
      provider,
      run() {},
      scope: byPrincipal,
    });
    const alice = await bindScheduleCollection("queries", definition, binding("alice", ["create"]));
    const bob = await bindScheduleCollection("queries", definition, binding("bob", ["get"]));
    await alice!.create({
      expression: { type: "single", at: "2026-10-01T09:00:00", timezone: "UTC" },
      payload: { query: "open incidents" },
      name: "reminder",
    });
    await expect(bob!.get("reminder")).resolves.toBeNull();

    const anonymous = await bindScheduleCollection("queries", definition, {
      ...binding("anonymous", []),
      session: { auth: { current: null, initiator: null }, id: "anonymous" },
    });
    expect(anonymous).toBeNull();
  });

  it("rejects invalid portable names, expressions, timezones, jitter, and limits", async () => {
    const definition = defineScheduleCollection({
      payloadSchema: z.object({ query: z.string().min(1) }),
      provider: inMemoryScheduleProvider(),
      run() {},
      scope: "test",
    });
    const client = await bindScheduleCollection(
      "queries",
      definition,
      binding("alice", ["a", "b", "c", "d"]),
    );
    const input = { query: "test" };

    await expect(
      client!.create({
        expression: { type: "cron", cron: "0 9 * *" },
        payload: input,
        name: "bad",
      }),
    ).rejects.toThrow("exactly five fields");
    await expect(
      client!.create({
        expression: { type: "cron", cron: "0 9 * * 0", timezone: "Not/AZone" },
        payload: input,
        name: "bad-zone",
      }),
    ).rejects.toThrow("Invalid IANA timezone");
    await expect(
      client!.create({
        expression: { type: "cron", cron: "0 9 * * 0", jitter: 16 },
        payload: input,
        name: "bad-jitter",
      }),
    ).rejects.toThrow("1 through 15");
    await expect(client!.list({ cursor: "", limit: 1 })).resolves.toMatchObject({
      cursor: null,
    });
    await expect(client!.list({ limit: 101 })).rejects.toThrow("1 through 100");
    await expect(
      client!.create({
        expression: { type: "cron", cron: "0 9 * * 0" },
        payload: { query: "" },
        name: "bad-input",
      }),
    ).rejects.toThrow("Invalid schedule input");

    await client!.create({
      expression: { type: "cron", cron: "0 9 * * 0" },
      payload: input,
      name: "immutable-type",
    });
    await expect(
      client!.update("immutable-type", {
        expression: { type: "single", at: "2026-10-01T09:00:00" },
      }),
    ).rejects.toThrow("cannot change between recurring and one-time");
  });
});
