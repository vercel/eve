import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createScheduleCollectionToolDynamicDefinition } from "#context/schedule-collection-tools.js";
import { defineScheduleCollection } from "#public/schedules/collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";

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
      "collection__create_schedule",
      "collection__list_schedules",
      "collection__read_schedule",
      "collection__update_schedule",
      "collection__enable_schedule",
      "collection__disable_schedule",
      "collection__delete_schedule",
    ]);
    expect(tools).not.toHaveProperty("collection__invoke_schedule");
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
