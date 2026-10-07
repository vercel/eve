import { describe, expect, it, vi } from "vitest";
import { z } from "#compiled/zod/index.js";
import { defineScheduleSubscription } from "#public/schedules/subscription.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import {
  createScheduleCollectionClient,
  type ScheduleBoundCallContext,
} from "#runtime/schedules/collection-client.js";

const callContext: ScheduleBoundCallContext = {
  abortSignal: new AbortController().signal,
  application: "fixture",
  collection: "requests",
  channel: {},
  session: {
    id: "session-alice",
    auth: {
      current: {
        attributes: { secret: "not-persisted" },
        authenticator: "test",
        principalId: "alice",
        principalType: "user",
      },
      initiator: null,
    },
  },
};
const payload = { task: "Summarize the week.", destination: "my-dm" as const };
function setup() {
  const provider = inMemoryScheduleProvider();
  const create = vi.spyOn(provider, "create");
  const definition = defineScheduleSubscription({
    provider,
    schema: z
      .object({ task: z.string().min(1), destination: z.enum(["my-dm", "team-channel"]) })
      .strict(),
    auth: () => null,
    run: async () => {},
  });
  const client = createScheduleCollectionClient(definition, callContext);
  return { provider, definition, client, create };
}
const input = { name: "report", expression: { type: "delay" as const, minutes: 5 }, payload };

describe("schedule subscription client", () => {
  it("allows repeated display names while returning distinct management names", async () => {
    const { client } = setup();
    const first = await client.create(input);
    const second = await client.create(input);
    expect(first.displayName).toBe("report");
    expect(second.displayName).toBe("report");
    expect(first.name).not.toBe(second.name);
    await client.delete(first.name);
    await expect(client.get(second.name)).resolves.toMatchObject({ displayName: "report" });
    const longest = await client.create({ ...input, name: "r".repeat(256) });
    expect(longest.name).toHaveLength(256);
    await expect(client.get(longest.name)).resolves.toMatchObject({ displayName: "r".repeat(218) });
  });
  it("stores validated destination intent and a separate credential-free creator reference", async () => {
    const { client, create } = setup();
    await client.create(input);
    expect(create.mock.calls[0]![1].payload).toEqual({
      eve: { application: "fixture", collection: "requests", version: 3 },
      envelope: {
        version: 3,
        payload,
        scope: '["user","test",null,"alice"]',
        principal: { type: "user", authenticator: "test", principalId: "alice" },
      },
    });
  });

  it("rejects invalid input before preparation, and rejected or oversized preparation before writes", async () => {
    const { definition, create } = setup();
    const prepare = vi.fn((value: { task: string; destination: "my-dm" | "team-channel" }) => {
      if (value.task === "reject") throw new Error("Destination unavailable.");
      return { message: "x".repeat(64 * 1024) };
    });
    const client = createScheduleCollectionClient(
      {
        schema: definition.schema,
        provider: definition.provider,
        prepare,
        auth: () => null,
        run: () => {},
      },
      callContext,
    );
    await expect(client.create({ ...input, payload: { ...payload, task: "" } })).rejects.toThrow(
      "Invalid schedule payload",
    );
    expect(prepare).not.toHaveBeenCalled();
    await expect(
      client.create({ ...input, payload: { ...payload, task: "reject" } }),
    ).rejects.toThrow("Destination unavailable");
    await expect(client.create(input)).rejects.toThrow("recreate the schedule");
    expect(create).not.toHaveBeenCalled();
  });

  it("isolates callers and checks policy separately for every management operation", async () => {
    const { definition, client, provider } = setup();
    const created = await client.create(input);
    const bob = createScheduleCollectionClient(definition, {
      ...callContext,
      session: {
        id: "bob",
        auth: {
          current: { ...callContext.session.auth.current!, principalId: "bob" },
          initiator: null,
        },
      },
    });
    await expect(bob.get(created.name)).resolves.toBeNull();
    await expect(bob.list()).resolves.toEqual({ cursor: null, data: [] });
    const scope = vi.fn(() => null);
    const prepare = vi.fn(
      (value: { task: string; destination: "my-dm" | "team-channel" }) => value,
    );
    const denied = createScheduleCollectionClient({ ...definition, scope, prepare }, callContext);
    const get = vi.spyOn(provider, "get");
    await expect(denied.get(created.name)).rejects.toThrow("not available");
    await expect(denied.delete(created.name)).rejects.toThrow("not available");
    await expect(denied.create(input)).rejects.toThrow("not available");
    expect(scope.mock.calls).toHaveLength(3);
    expect(prepare).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses scheduled-execution management through the custom client too", async () => {
    const { definition, create } = setup();
    const scheduled = createScheduleCollectionClient(definition, {
      ...callContext,
      session: {
        ...callContext.session,
        schedule: { definition: "requests", occurrenceId: "exec-1" },
      },
    });
    await expect(scheduled.create(input)).rejects.toThrow("unavailable during scheduled execution");
    expect(create).not.toHaveBeenCalled();
  });
});
