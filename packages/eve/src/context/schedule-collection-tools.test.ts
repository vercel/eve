import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createScheduleCollectionToolDynamicDefinition } from "#context/schedule-collection-tools.js";
import { defineScheduleCollection } from "#public/schedules/collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { readDurableDynamicToolCallbacks } from "#tools/durable-callbacks.js";
import { serializeInputSchema, type ToolSchemaSource } from "#tools/schema.js";

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
  it("contributes every management tool by default", async () => {
    const definition = defineScheduleCollection({
      payloadSchema: z.object({
        message: z.string().min(1).describe("The message to send."),
        priority: z.enum(["low", "high"]).describe("Delivery priority."),
      }),
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
      "schedule__collection__invoke",
    ]);
    const callbacks = readDurableDynamicToolCallbacks(tools!.schedule__collection__create!);
    expect(callbacks?.execute).toBeDefined();
    expect(callbacks?.inputSchema).toBeDefined();
    expect(callbacks?.approvalRequest).toBeDefined();

    for (const operation of ["create", "update"] as const) {
      const tool = tools![`schedule__collection__${operation}`] as {
        readonly inputSchema: ToolSchemaSource;
      };
      expect(serializeInputSchema(tool.inputSchema)).toMatchObject({
        properties: {
          payload: {
            properties: {
              message: { description: "The message to send.", minLength: 1, type: "string" },
              priority: {
                description: "Delivery priority.",
                enum: ["low", "high"],
                type: "string",
              },
            },
            required: ["message", "priority"],
            type: "object",
          },
        },
      });
    }
  });

  it("omits every generated tool when tools is false", async () => {
    const definition = defineScheduleCollection({
      payloadSchema: z.object({ message: z.string() }),
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
