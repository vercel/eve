import { describe, expect, it, vi } from "vitest";
import { z } from "#compiled/zod/index.js";
import { defineDynamicSchedules } from "#public/schedules/subscription.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import {
  createScheduleCollectionClient,
  type ScheduleBoundCallContext,
} from "#runtime/schedules/collection-client.js";

const callContext: ScheduleBoundCallContext = {
  abortSignal: new AbortController().signal,
  application: "fixture",
  collection: "requests",
  channel: { kind: "unknown", metadata: {} },
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
  const definition = defineDynamicSchedules({
    provider,
    inputSchema: z
      .object({ task: z.string().min(1), destination: z.enum(["my-dm", "team-channel"]) })
      .strict(),
    auth: () => null,
    run: async () => {},
  });
  const client = createScheduleCollectionClient(definition, callContext);
  return { provider, definition, client, create };
}
const input = { name: "report", expression: { type: "delay" as const, minutes: 5 }, payload };

describe("dynamic schedules client", () => {
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

  it("asks the provider to validate timing before it prepares a create or a timing update", async () => {
    const { definition, provider, create } = setup();
    const prepare = vi.fn(
      (value: { task: string; destination: "my-dm" | "team-channel" }) => value,
    );
    // A provider may check against its backend, so the hook can be async.
    const validateExpression = vi.fn(async (expression: { type: string; cron?: string }) => {
      if (expression.cron === "0 9 * * MON") throw new Error("Provider can't run MON.");
    });
    const client = createScheduleCollectionClient(
      { ...definition, provider: { ...provider, validateExpression }, preparePayload: prepare },
      callContext,
    );
    const cron = (value: string) => ({ type: "cron" as const, cron: value });

    await expect(
      client.prepareCreate({ ...input, expression: cron("0 9 * * MON") }),
    ).rejects.toThrow("Provider can't run MON.");
    expect(prepare).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    const created = await client.create({ ...input, expression: cron("0 9 * * 1") });
    await expect(
      client.prepareUpdate(created.name, { expression: cron("0 9 * * MON") }),
    ).rejects.toThrow("Provider can't run MON.");
    // eve's own timing rules still apply, with the hook and without it.
    for (const bound of [client, setup().client]) {
      await expect(bound.prepareCreate({ ...input, expression: cron("0 9 * *") })).rejects.toThrow(
        "exactly five fields",
      );
    }
    // A relative delay reaches the provider as the one-time expression it resolves to.
    await client.prepareCreate(input);
    expect(validateExpression).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "single", timezone: "UTC" }),
    );
  });

  it("rejects invalid input before preparation, and rejected or oversized preparation before writes", async () => {
    const { definition, create } = setup();
    const prepare = vi.fn((value: { task: string; destination: "my-dm" | "team-channel" }) => {
      if (value.task === "reject") throw new Error("Destination unavailable.");
      return { message: "x".repeat(64 * 1024) };
    });
    const client = createScheduleCollectionClient(
      {
        inputSchema: definition.inputSchema,
        provider: definition.provider,
        preparePayload: prepare,
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

  it.each([false, true])("caller isolation and scope (scheduled: %s)", async (scheduled) => {
    const { definition, provider } = setup();
    const context = {
      ...callContext,
      session: {
        ...callContext.session,
        schedule: scheduled ? { definition: "requests", occurrenceId: "exec-1" } : undefined,
      },
    };
    const client = createScheduleCollectionClient(definition, context);
    const created = await client.create(input);
    const bob = createScheduleCollectionClient(definition, {
      ...context,
      session: {
        ...context.session,
        id: "bob",
        auth: {
          current: { ...callContext.session.auth.current!, principalId: "bob" },
          initiator: null,
        },
      },
    });
    await expect(bob.get(created.name)).resolves.toBeNull();
    await expect(bob.list()).resolves.toEqual({ cursor: null, data: [] });
    await expect(bob.update(created.name, { payload })).rejects.toThrow("not found");
    const scope = vi.fn(() => null);
    const prepare = vi.fn(
      (value: { task: string; destination: "my-dm" | "team-channel" }) => value,
    );
    const denied = createScheduleCollectionClient(
      { ...definition, scope, preparePayload: prepare },
      context,
    );
    const get = vi.spyOn(provider, "get");
    await expect(denied.get(created.name)).rejects.toThrow("not available");
    await expect(denied.delete(created.name)).rejects.toThrow("not available");
    await expect(denied.update(created.name, { payload })).rejects.toThrow("not available");
    await expect(denied.create(input)).rejects.toThrow("not available");
    expect(scope.mock.calls).toHaveLength(4);
    expect(prepare).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects empty, unsupported, invalid, and missing schedule updates without writing", async () => {
    const { client, provider } = setup();
    const created = await client.create(input);
    const update = vi.spyOn(provider, "update");
    // @ts-expect-error TypeScript callers must supply timing or replacement payload.
    await expect(client.update(created.name, {})).rejects.toThrow(
      "requires an expression or replacement payload",
    );
    await expect(client.update(created.name, { name: "renamed" } as never)).rejects.toThrow(
      "does not support",
    );
    await expect(
      client.update(created.name, { payload: { ...payload, task: "" } }),
    ).rejects.toThrow("Invalid schedule payload");
    await expect(client.update("missing", { payload })).rejects.toThrow("not found");
    await expect(
      client.update(created.name, { expression: { type: "delay", minutes: 0 } }),
    ).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
    await expect(client.get(created.name)).resolves.toEqual(created);
  });
});
