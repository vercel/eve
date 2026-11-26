import { describe, expect, it, vi } from "vitest";
import { z } from "#compiled/zod/index.js";
import type { AuthResult } from "#channel/auth/definitions.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { defineDynamicSchedules, schedules } from "#public/schedules/index.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { vercelScheduleProvider } from "#public/schedules/providers/vercel.js";
import { withLocalDevRequestScope } from "#runtime/local-dev-capability.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import type { ScheduleProvider } from "#public/schedules/subscription.js";
import { stampScheduleCollectionSource } from "#shared/schedule-collection-definition.js";

const workspace = (id: string): AuthResult => ({
  attributes: {},
  authenticator: "workspace-token",
  principalId: `workspace:${id}`,
  principalType: "service",
});
const principalA = workspace("ws_a");
const principalB = workspace("ws_b");
const expression = { type: "delay" as const, minutes: 5 };
const payload = { task: "Summarize the week." };

function setup(provider: ScheduleProvider = inMemoryScheduleProvider()) {
  const definition = defineDynamicSchedules({
    provider,
    tool: false,
    inputSchema: z.object({ task: z.string() }).strict(),
    scope: ({ session }) => session.auth.current?.principalId ?? null,
    auth: () => ({ attributes: {} }),
    run: async () => {},
  });
  stampScheduleCollectionSource(definition, {
    application: "fixture",
    collection: "requests",
    logicalPath: "schedules/requests.ts",
    sourceId: "requests",
  });
  return definition;
}

describe("schedules() outside a turn", () => {
  it("manages a schedule as the verified principal passed as auth", async () => {
    const definition = setup();
    const client = await schedules(definition, { auth: principalA });
    const created = await client.create({ name: "weekly", expression, payload });
    expect((await client.list()).data.map((record) => record.name)).toEqual([created.name]);
    await expect(client.get(created.name)).resolves.toMatchObject({ displayName: "weekly" });
    await expect(
      client.update(created.name, { expression: { type: "delay", minutes: 10 } }),
    ).resolves.toMatchObject({ name: created.name });
    await expect(client.disable(created.name)).resolves.toMatchObject({ state: "inactive" });
    await expect(client.enable(created.name)).resolves.toMatchObject({ state: "active" });
    await expect(client.delete(created.name)).resolves.toBe(true);
    expect((await client.list()).data).toEqual([]);
  });

  it("keeps one principal's schedules out of another principal's client", async () => {
    const definition = setup();
    const clientA = await schedules(definition, { auth: principalA });
    const clientB = await schedules(definition, { auth: principalB });
    const created = await clientA.create({ name: "weekly", expression, payload });

    expect((await clientB.list()).data).toEqual([]);
    await expect(clientB.get(created.name)).resolves.toBeNull();
    await expect(clientB.update(created.name, { payload })).rejects.toThrow("not found");
    await expect(clientB.delete(created.name)).resolves.toBe(false);
    expect((await clientA.list()).data.map((record) => record.name)).toEqual([created.name]);
  });

  it("rejects a client with no auth when no turn is active", async () => {
    await expect(schedules(setup())).rejects.toThrow("No active eve context");
  });

  it("accepts auth in a channel route handler's local dev request scope", async () => {
    const definition = setup();
    const client = await withLocalDevRequestScope(new Request("http://x/"), () =>
      schedules(definition, { auth: principalA }),
    );
    await expect(client.create({ name: "weekly", expression, payload })).resolves.toMatchObject({
      displayName: "weekly",
    });
  });

  it("rejects auth inside a turn scope holding a session id", async () => {
    const definition = setup();
    const scope = new ContextContainer();
    scope.set(SessionIdKey, "session_1");
    await expect(
      contextStorage.run(scope, () => schedules(definition, { auth: principalA })),
    ).rejects.toThrow("a turn's principal cannot be overridden");
  });

  it("rejects auth inside a scope holding an auth principal", async () => {
    const definition = setup();
    const scope = new ContextContainer();
    scope.set(AuthKey, null);
    await expect(
      contextStorage.run(scope, () => schedules(definition, { auth: principalA })),
    ).rejects.toThrow("a turn's principal cannot be overridden");
  });

  it("rejects invoke on the in-memory provider with a precise error", async () => {
    const client = await schedules(setup(), { auth: principalA });
    await expect(client.invoke("weekly")).rejects.toThrow("invoke is only available inside a turn");
  });

  it("rejects invoke on the vercel provider without calling the schedule API", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}));
    const client = await schedules(setup(vercelScheduleProvider({ fetch: fetchImpl })), {
      auth: principalA,
    });
    await expect(client.invoke("weekly")).rejects.toThrow("invoke is only available inside a turn");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
