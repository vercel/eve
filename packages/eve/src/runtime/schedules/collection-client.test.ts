import { describe, expect, it, vi } from "vitest";

import { defineScheduleCollection } from "#public/schedules/collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { byPrincipal } from "#public/schedules/scope.js";
import {
  bindScheduleCollection,
  type ScheduleCollectionBindingContext,
} from "#runtime/schedules/collection-client.js";

function binding(principalId: string, operationIds: string[]): ScheduleCollectionBindingContext {
  let index = 0;
  return {
    abortSignal: new AbortController().signal,
    application: "fixture",
    channel: { kind: "eve" },
    session: {
      id: "session_1",
      auth: {
        current: { attributes: {}, authenticator: "test", principalId, principalType: "user" },
        initiator: null,
      },
    },
    operationId: () => operationIds[index++] ?? `operation_${index}`,
  };
}

describe("bindScheduleCollection", () => {
  it("deletes a bounded batch with one operation per unique name and per-schedule results", async () => {
    const provider = inMemoryScheduleProvider();
    const names = ["first", "second", "missing"];
    const definition = defineScheduleCollection({ provider, scope: "shared", runAs: "app" });
    const client = await bindScheduleCollection(
      "tasks",
      definition,
      binding("alice", ["create-a", "create-b", "delete-a", "delete-b", "delete-missing"]),
    );
    for (const name of names.slice(0, 2)) {
      await client!.create({
        name,
        payload: "task",
        expression: { type: "cron", cron: "0 9 * * *" },
      });
    }
    await expect(client!.delete(["first", "second", "first", "missing"])).resolves.toEqual([
      { name: "first", status: "deleted" },
      { name: "second", status: "deleted" },
      { name: "missing", status: "not-found" },
    ]);
    await expect(client!.delete([])).rejects.toThrow("Delete between 1 and 25 schedules");
    await expect(
      client!.delete(Array.from({ length: 26 }, (_, index) => `schedule-${index}`)),
    ).rejects.toThrow("Delete between 1 and 25 schedules");
  });
  it("continues a batch after an individual provider deletion fails", async () => {
    const provider = inMemoryScheduleProvider();
    const deleteSchedule = vi.spyOn(provider, "delete");
    deleteSchedule.mockRejectedValueOnce(new Error("private provider detail"));
    const definition = defineScheduleCollection({ provider, scope: "shared", runAs: "app" });
    const client = await bindScheduleCollection(
      "tasks",
      definition,
      binding("alice", ["delete-1", "delete-2", "delete-3"]),
    );
    await expect(client!.delete(["first", "second", "third"])).resolves.toEqual([
      { name: "first", status: "failed" },
      { name: "second", status: "not-found" },
      { name: "third", status: "not-found" },
    ]);
    expect(deleteSchedule).toHaveBeenCalledTimes(3);
  });

  it("stores a bounded request and dispatches it from an in-memory occurrence", async () => {
    const deliveries: unknown[] = [];
    const definition = defineScheduleCollection({
      provider: inMemoryScheduleProvider({ now: () => new Date("2026-09-20T12:00:00.000Z") }),
      scope: byPrincipal,
      runAs: "creator",
    });
    const client = await bindScheduleCollection(
      "tasks",
      definition,
      binding("alice", ["create", "invoke"]),
      async (delivery) => {
        deliveries.push(delivery);
      },
    );
    await client!.create({
      expression: { type: "cron", cron: "0 9 * * *" },
      name: "morning",
      payload: "Review open incidents",
    });
    await client!.invoke("morning");
    expect(deliveries).toEqual([
      {
        payload: expect.objectContaining({
          version: 1,
          request: "Review open incidents",
          runAs: "creator",
          origin: {
            sessionId: "session_1",
            auth: binding("alice", []).session.auth,
            channel: { kind: "eve" },
          },
        }),
        occurrence: expect.objectContaining({ name: "morning" }),
      },
    ]);
  });

  it("preserves the original snapshot on timing edits and refuses request replacement", async () => {
    const delivered: unknown[] = [];
    const provider = inMemoryScheduleProvider();
    const definition = defineScheduleCollection({ provider, scope: "shared", runAs: "creator" });
    const source = binding("alice", ["create"]);
    const alice = await bindScheduleCollection("tasks", definition, source, async (value) => {
      delivered.push(value);
    });
    Object.assign(source.session.auth.current!, { principalId: "bob" });
    await alice!.create({
      name: "daily",
      payload: "Alice's task",
      expression: { type: "cron", cron: "0 9 * * *" },
    });
    const bob = await bindScheduleCollection(
      "tasks",
      definition,
      binding("bob", ["get", "update", "invoke"]),
    );
    await expect(bob!.update("daily", { payload: "Bob's replacement" })).rejects.toThrow(
      "delete and recreate",
    );
    await bob!.update("daily", { expression: { type: "cron", cron: "0 10 * * *" } });
    await bob!.invoke("daily");
    expect(delivered).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          request: "Alice's task",
          origin: expect.objectContaining({
            auth: expect.objectContaining({
              current: expect.objectContaining({ principalId: "alice" }),
            }),
          }),
        }),
      }),
    ]);
  });

  it("isolates scopes for separate principals and disables anonymous callers", async () => {
    const definition = defineScheduleCollection({
      provider: inMemoryScheduleProvider(),
      scope: byPrincipal,
      runAs: "creator",
    });
    const alice = await bindScheduleCollection("tasks", definition, binding("alice", ["create"]));
    const bob = await bindScheduleCollection("tasks", definition, binding("bob", ["list", "get"]));
    await alice!.create({
      expression: { type: "cron", cron: "0 9 * * *" },
      name: "private",
      payload: "Review incidents",
    });
    await expect(bob!.list()).resolves.toEqual({ cursor: null, data: [] });
    await expect(bob!.get("private")).resolves.toBeNull();
    const anonymous = await bindScheduleCollection("tasks", definition, {
      ...binding("anonymous", []),
      session: { id: "anonymous", auth: { current: null, initiator: null } },
    });
    expect(anonymous).toBeNull();
  });

  it("validates schedule expression, request and pagination", async () => {
    const definition = defineScheduleCollection({
      provider: inMemoryScheduleProvider(),
      scope: "test",
      runAs: "app",
    });
    const client = await bindScheduleCollection(
      "tasks",
      definition,
      binding("alice", ["one", "two", "three", "four"]),
    );
    await expect(
      client!.create({
        expression: { type: "cron", cron: "0 9 * *" },
        name: "invalid",
        payload: "task",
      }),
    ).rejects.toThrow("exactly five fields");
    await expect(
      client!.create({
        expression: { type: "cron", cron: "0 9 * * *" },
        name: "invalid",
        payload: " ",
      }),
    ).rejects.toThrow("Scheduled request must be a non-empty string");
    await expect(
      client!.create({
        expression: { type: "cron", cron: "0 9 * * *" },
        name: "invalid",
        payload: "x".repeat(2_001),
      }),
    ).rejects.toThrow("at most 2000 characters");
    await expect(client!.list({ limit: 101 })).rejects.toThrow("1 through 100");
  });
});
