import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createScheduleCollectionToolDynamicDefinition } from "#context/schedule-collection-tools.js";
import { defineScheduleCollection } from "#public/schedules/collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { readDurableDynamicToolCallbacks } from "#tools/durable-callbacks.js";

const resolveContext = {
  abortSignal: new AbortController().signal,
  channel: { kind: "eve" },
  messages: [],
  model: null,
  session: {
    auth: {
      current: {
        attributes: {},
        authenticator: "test",
        principalId: "alice",
        principalType: "user",
      },
      initiator: null,
    },
    id: "session_1",
  },
};

describe("schedule collection tools", () => {
  it("contributes management tools automatically and keeps invoke disabled by default", async () => {
    const definition = defineScheduleCollection({
      inputSchema: z.object({ message: z.string().min(1) }),
      provider: inMemoryScheduleProvider(),
      run() {},
      scope: "fixture",
      tools: true,
    });
    const dynamic = createScheduleCollectionToolDynamicDefinition(definition, {
      application: "fixture",
      collection: "collection",
    });
    const tools = await dynamic.events["turn.started"]!({}, resolveContext);

    expect(Object.keys(tools!)).toEqual([
      "schedule__collection__create",
      "schedule__collection__list",
      "schedule__collection__read",
      "schedule__collection__update",
      "schedule__collection__enable",
      "schedule__collection__disable",
      "schedule__collection__delete",
    ]);
    expect(tools).not.toHaveProperty("schedule__collection__invoke");
    expect(
      readDurableDynamicToolCallbacks(tools!.schedule__collection__create!)?.execute,
    ).toBeDefined();
    expect(
      readDurableDynamicToolCallbacks(tools!.schedule__collection__create!)?.approvalRequest,
    ).toBeDefined();
  });

  it("omits every generated tool when tools is false", async () => {
    const definition = defineScheduleCollection({
      inputSchema: z.object({ message: z.string() }),
      provider: inMemoryScheduleProvider(),
      run() {},
      scope: "fixture",
      tools: false,
    });
    const dynamic = createScheduleCollectionToolDynamicDefinition(definition, {
      application: "fixture",
      collection: "collection",
    });

    await expect(dynamic.events["turn.started"]!({}, resolveContext)).resolves.toBeNull();
  });
});
