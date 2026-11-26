import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";
import type { AuthResult } from "#channel/auth/definitions.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { defineDynamicSchedules, schedules } from "#public/schedules/index.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
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

function setup() {
  const definition = defineDynamicSchedules({
    provider: inMemoryScheduleProvider(),
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

  it("rejects auth inside a turn, whose principal never changes", async () => {
    const definition = setup();
    await expect(
      contextStorage.run(new ContextContainer(), () => schedules(definition, { auth: principalA })),
    ).rejects.toThrow("a turn's principal cannot be overridden");
  });
});
