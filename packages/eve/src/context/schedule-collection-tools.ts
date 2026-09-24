import { always } from "#tools/approval/policies.js";
import type { DynamicResolveContext } from "#dynamic/definition.js";
import { defineDynamic } from "#dynamic/definition.js";
import { markDynamicCallbackRebind } from "#internal/dynamic-tool-rebind.js";
import type {
  ScheduleCollectionDefinition,
  ScheduleExpression,
} from "#public/schedules/collection.js";
import { bindScheduleCollection } from "#runtime/schedules/collection-client.js";
import { defineTool } from "#tools/definition.js";
import type { DynamicToolEntry } from "#tools/dynamic.js";
import { parseJsonObject } from "#shared/json.js";
import { serializeInputSchema, toInputSchema } from "#tools/schema.js";
import {
  readDurableDynamicToolCallbacks,
  stampDurableDynamicToolCallbacks,
} from "#tools/durable-callbacks.js";
import { z } from "#compiled/zod/index.js";

const scheduleNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[0-9A-Za-z][0-9A-Za-z._-]*$/u)
  .describe(
    "Stable schedule identifier. Start with a letter or digit and use only letters, digits, dots, underscores, and dashes. Convert a human title to a slug such as review-prs-daily; do not use spaces.",
  );

const timezoneSchema = z
  .string()
  .describe(
    "IANA timezone such as America/New_York or UTC. Optional; omission uses UTC. For a relative delay, calculate a UTC one-time date from a reliable current clock; do not ask for the user's timezone. Ask for a timezone only when an absolute local wall-clock time would otherwise be ambiguous.",
  );

const expressionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cron"),
    cron: z.string().describe("Standard five-field cron expression."),
    timezone: timezoneSchema.optional(),
    jitter: z
      .number()
      .int()
      .min(1)
      .max(15)
      .optional()
      .describe(
        "Optional maximum random delay in minutes. Omit to use the provider and plan default; set only when the user requests a jitter window.",
      ),
  }),
  z.object({
    type: z.literal("single"),
    at: z
      .string()
      .describe(
        "Minute-precision local datetime in YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:00 format without an offset or fractional seconds.",
      ),
    timezone: timezoneSchema.optional(),
  }),
]);

export function createScheduleCollectionToolDynamicDefinition<TInput>(
  definition: ScheduleCollectionDefinition<TInput>,
  input: { readonly application: string; readonly collection: string },
) {
  return markDynamicCallbackRebind(
    defineDynamic({
      events: {
        "turn.started": async (_event, context) => {
          const options = resolveToolOptions(definition.tools);
          if (options === null) return null;
          const client = await bindScheduleCollection(
            input.collection,
            definition,
            bindingContext(input.application, context),
          );
          if (client === null) return null;

          const tools: Record<string, unknown> = {};
          const description = (value: string) =>
            definition.description === undefined ? value : `${definition.description}\n\n${value}`;

          const toolName = (operation: string) => `schedule__${input.collection}__${operation}`;

          if (options.create) {
            tools[toolName("create")] = defineTool({
              approval: always(),
              description: description(
                "Create a recurring or one-time schedule in this collection.",
              ),
              inputSchema: scheduleCreateToolSchema(definition.payloadSchema),
              execute: async (toolInput) => {
                const input = toolInput as {
                  readonly expression: ScheduleExpression;
                  readonly name: string;
                  readonly payload: TInput;
                  readonly state?: "active" | "inactive";
                };
                return await client.create(input);
              },
            });
          }
          if (options.read) {
            tools[toolName("list")] = defineTool({
              description: description("List schedules in this collection for the current scope."),
              inputSchema: z.object({
                cursor: z
                  .string()
                  .optional()
                  .describe(
                    "Pagination cursor returned by a prior list call. Omit for the first page.",
                  ),
                limit: z.number().int().optional(),
              }),
              execute: async (toolInput) => await client.list(toolInput),
            });
            tools[toolName("read")] = defineTool({
              description: description("Read one schedule in this collection by its exact name."),
              inputSchema: z.object({ name: scheduleNameSchema }),
              execute: async ({ name }) => await client.get(name),
            });
          }
          if (options.update) {
            tools[toolName("update")] = defineTool({
              approval: always(),
              description: description("Update the timing or typed input of an existing schedule."),
              inputSchema: scheduleUpdateToolSchema(definition.payloadSchema),
              execute: async (toolInput) => {
                const { name, ...patch } = toolInput as {
                  readonly expression?: ScheduleExpression;
                  readonly name: string;
                  readonly payload?: TInput;
                };
                const update: { expression?: ScheduleExpression; payload?: TInput } = {};
                if (patch.expression !== undefined) update.expression = patch.expression;
                if (patch.payload !== undefined) update.payload = patch.payload;
                return await client.update(name, update);
              },
            });
            tools[toolName("enable")] = defineTool({
              approval: always(),
              description: description("Enable an inactive schedule."),
              inputSchema: z.object({ name: scheduleNameSchema }),
              execute: async ({ name }) => await client.enable(name),
            });
            tools[toolName("disable")] = defineTool({
              approval: always(),
              description: description("Disable a schedule without deleting it."),
              inputSchema: z.object({ name: scheduleNameSchema }),
              execute: async ({ name }) => await client.disable(name),
            });
          }
          if (options.delete) {
            tools[toolName("delete")] = defineTool({
              approval: always(),
              description: description("Permanently delete a schedule from this collection."),
              inputSchema: z.object({ name: scheduleNameSchema }),
              execute: async ({ name }) => ({ deleted: await client.delete(name) }),
            });
          }
          if (options.invoke) {
            tools[toolName("invoke")] = defineTool({
              approval: always(),
              description: description("Run a schedule now without changing its timing or state."),
              inputSchema: z.object({ name: scheduleNameSchema }),
              execute: async ({ name }) => {
                await client.invoke(name);
                return { invoked: true };
              },
            });
          }
          return Object.fromEntries(
            Object.entries(tools).map(([name, tool]) => {
              stampGeneratedToolCallbacks(tool);
              return [name, tool];
            }),
          );
        },
      },
    }),
  );
}

function scheduleCreateToolSchema(payloadSchema: unknown) {
  return toInputSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      expression: serializeInputSchema(expressionSchema),
      name: serializeInputSchema(scheduleNameSchema),
      payload: serializeInputSchema(payloadSchema as never),
      state: { enum: ["active", "inactive"], type: "string" },
    },
    required: ["expression", "name", "payload"],
  });
}

function scheduleUpdateToolSchema(payloadSchema: unknown) {
  return toInputSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      expression: serializeInputSchema(expressionSchema.optional()),
      name: serializeInputSchema(scheduleNameSchema),
      payload: serializeInputSchema(payloadSchema as never),
    },
    required: ["name"],
  });
}

function stampGeneratedToolCallbacks(tool: unknown): void {
  const entry = tool as DynamicToolEntry;
  const closure = parseJsonObject({});
  const callbacks: Parameters<typeof stampDurableDynamicToolCallbacks>[1] = {
    ...readDurableDynamicToolCallbacks(entry),
    execute: {
      callback: async (_rawClosure, toolInput, context) => await entry.execute(toolInput, context),
      closure,
    },
    inputSchema: {
      callback: async () => entry.inputSchema,
      closure,
    },
  };
  stampDurableDynamicToolCallbacks(entry, callbacks);
}

function bindingContext(application: string, context: DynamicResolveContext) {
  return {
    abortSignal: context.abortSignal ?? new AbortController().signal,
    application,
    channel: context.channel,
    targetKey: application,
    session: context.session,
  };
}

function resolveToolOptions(tools: ScheduleCollectionDefinition["tools"]): {
  create: boolean;
  delete: boolean;
  invoke: boolean;
  read: boolean;
  update: boolean;
} | null {
  if (tools === false) return null;
  if (tools === undefined || tools === true) {
    return { create: true, delete: true, invoke: true, read: true, update: true };
  }
  return {
    create: tools.create ?? true,
    delete: tools.delete ?? true,
    invoke: tools.invoke ?? true,
    read: tools.read ?? true,
    update: tools.update ?? true,
  };
}
