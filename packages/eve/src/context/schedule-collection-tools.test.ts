import { describe, expect, it, vi } from "vitest";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { buildSlackAuthContext } from "#public/channels/slack/auth.js";
import { parseSchedulePayload } from "#runtime/schedules/payload.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { ScheduleOriginKey } from "#context/keys.js";
import { serializeContext, deserializeContext } from "#context/serialize.js";

import { createScheduleCollectionToolDynamicDefinition } from "#context/schedule-collection-tools.js";
import { defineScheduleCollection } from "#public/schedules/collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { byPrincipal } from "#public/schedules/scope.js";
import { readDurableDynamicToolCallbacks } from "#tools/durable-callbacks.js";
import type { DynamicToolEntry } from "#tools/dynamic.js";
import { serializeInputSchema, type ToolSchemaSource } from "#tools/schema.js";

function resolveContext(principalId = "alice") {
  return {
    abortSignal: new AbortController().signal,
    channel: { kind: "eve" },
    messages: [],
    model: null,
    session: {
      auth: {
        current: { attributes: {}, authenticator: "test", principalId, principalType: "user" },
        initiator: null,
      },
      id: "session_1",
    },
  };
}

describe("schedule collection tools", () => {
  it("contributes a small management toolset with a fixed request schema", async () => {
    const definition = defineScheduleCollection({
      provider: inMemoryScheduleProvider(),
      scope: "fixture",
      runAs: "app",
    });
    const dynamic = createScheduleCollectionToolDynamicDefinition(definition, {
      application: "fixture",
      collection: "collection",
    });
    const tools = await dynamic.events["turn.started"]!({}, resolveContext());
    expect(Object.keys(tools!)).toEqual([
      "schedule__collection__create",
      "schedule__collection__list",
      "schedule__collection__delete",
    ]);
    const create = tools!.schedule__collection__create as { inputSchema: ToolSchemaSource };
    const deleteTool = tools!.schedule__collection__delete as { inputSchema: ToolSchemaSource };
    expect(serializeInputSchema(deleteTool.inputSchema)).toMatchObject({
      properties: {
        names: { type: "array", minItems: 1, maxItems: 25, items: { type: "string" } },
      },
      required: ["names"],
      additionalProperties: false,
    });
    expect(serializeInputSchema(create.inputSchema)).toMatchObject({
      properties: {
        request: { type: "string", minLength: 1, maxLength: 2_000 },
      },
      required: ["expression", "name", "request"],
    });
    const schema = serializeInputSchema(create.inputSchema);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["expression", "name", "request"]);
    const callbacks = readDurableDynamicToolCallbacks(tools!.schedule__collection__create!);
    expect(callbacks?.execute).toBeDefined();
    expect(callbacks?.inputSchema).toBeDefined();
    expect(callbacks?.approvalRequest).toBeDefined();
  });

  it.each(["creator", "app"] as const)(
    "excludes management during %s scheduled runs, including rebound callbacks",
    async (runAs) => {
      const definition = defineScheduleCollection({
        provider: inMemoryScheduleProvider(),
        scope: "shared",
        runAs,
      });
      const dynamic = createScheduleCollectionToolDynamicDefinition(definition, {
        application: "fixture",
        collection: "collection",
      });
      const context = resolveContext();
      const tools = await dynamic.events["turn.started"]!({}, context);
      const scope = new ContextContainer();
      scope.set(ScheduleOriginKey, {
        sessionId: context.session.id,
        auth: context.session.auth,
        channel: context.channel,
      });
      const restored = await deserializeContext(
        JSON.parse(JSON.stringify(serializeContext(scope))),
      );
      await contextStorage.run(restored, async () => {
        await expect(dynamic.events["turn.started"]!({}, context)).resolves.toBeNull();
        for (const tool of Object.values(tools!)) {
          await expect(
            (tool as DynamicToolEntry).execute({ names: ["daily"] }, {} as never),
          ).rejects.toThrow("Schedule management is unavailable");
        }
      });
    },
  );

  it("captures installation context from the channel when generated tools bind", async () => {
    const provider = inMemoryScheduleProvider();
    const create = vi.spyOn(provider, "create");
    const dynamic = createScheduleCollectionToolDynamicDefinition(
      defineScheduleCollection({ provider, scope: byPrincipal, runAs: "creator" }),
      { application: "fixture", collection: "collection" },
    );
    const auth = buildSlackAuthContext({
      teamId: "T123",
      channelId: "C123",
      userId: "U123",
      threadTs: "1700000000.000001",
    });
    const scope = new ContextContainer();
    const state = {
      installationTeamId: "T999",
      teamId: "T123",
      channelId: "C123",
      triggeringUserId: "U123",
      threadTs: "1700000000.000001",
      pendingApprovalCards: { private: "not copied" },
    };
    scope.set(ChannelKey, { kind: "channel:team-chat", state });
    const tools = await contextStorage.run(scope, () =>
      dynamic.events["turn.started"]!(
        {},
        {
          ...resolveContext(),
          session: { id: "session_1", auth: { current: auth, initiator: null } },
          channel: { kind: "channel:team-chat", metadata: { installationTeamId: "TUNTRUSTED" } },
        },
      ),
    );
    state.installationTeamId = "T456";
    await (tools!.schedule__collection__create as DynamicToolEntry).execute(
      {
        name: "report",
        request: "Send the report",
        expression: { type: "cron", cron: "0 9 * * *" },
      },
      {} as never,
    );
    const stored = parseSchedulePayload(create.mock.calls[0]![1].payload);
    expect(stored.origin.slack).toEqual({
      installationTeamId: "T999",
      teamId: "T123",
      userId: "U123",
      channelId: "C123",
      threadTs: "1700000000.000001",
    });
    expect(JSON.stringify(stored)).not.toContain("not copied");
    expect(JSON.stringify(stored)).not.toContain("TUNTRUSTED");
  });

  it("omits tools when disabled", async () => {
    const definition = defineScheduleCollection({
      provider: inMemoryScheduleProvider(),
      scope: "fixture",
      tools: false,
      runAs: "app",
    });
    const dynamic = createScheduleCollectionToolDynamicDefinition(definition, {
      application: "fixture",
      collection: "collection",
    });
    await expect(dynamic.events["turn.started"]!({}, resolveContext())).resolves.toBeNull();
  });

  it("isolates generated management calls by the current authenticated caller", async () => {
    const definition = defineScheduleCollection({
      provider: inMemoryScheduleProvider(),
      scope: byPrincipal,
      runAs: "creator",
    });
    const dynamic = createScheduleCollectionToolDynamicDefinition(definition, {
      application: "fixture",
      collection: "collection",
    });
    const aliceTools = await dynamic.events["turn.started"]!({}, resolveContext("alice"));
    await (aliceTools!.schedule__collection__create as DynamicToolEntry).execute(
      {
        name: "alice-only",
        expression: { type: "cron", cron: "0 9 * * *" },
        request: "Check Alice's report.",
      },
      {} as never,
    );
    const bobTools = await dynamic.events["turn.started"]!({}, resolveContext("bob"));
    await expect(
      (bobTools!.schedule__collection__list as DynamicToolEntry).execute({}, {} as never),
    ).resolves.toEqual({ cursor: null, data: [] });
  });
});
