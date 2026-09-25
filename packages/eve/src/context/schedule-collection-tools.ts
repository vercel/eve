import { z } from "#compiled/zod/index.js";
import { contextStorage } from "#context/container.js";
import { ScheduleOriginKey } from "#context/keys.js";
import type { DynamicResolveContext } from "#dynamic/definition.js";
import { defineDynamic } from "#dynamic/definition.js";
import { markDynamicCallbackRebind } from "#internal/dynamic-tool-rebind.js";
import { parseJsonObject } from "#shared/json.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import type { DynamicToolEntry } from "#tools/dynamic.js";
import {
  readDurableDynamicToolCallbacks,
  stampDurableDynamicToolCallbacks,
} from "#tools/durable-callbacks.js";
import type {
  ScheduleCollectionDefinition,
  ScheduleExpression,
} from "#public/schedules/collection.js";
import { bindScheduleCollection } from "#runtime/schedules/collection-client.js";

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
    "IANA timezone such as America/New_York or UTC. Optional; omission uses UTC. For a relative delay, first check a reliable current clock—for example, run `date -u` with bash when that tool is available—then calculate the UTC one-time date. Never guess the current time. Do not ask for the user's timezone for a relative delay; ask only when an absolute local wall-clock time is ambiguous.",
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
      .describe("Optional maximum random delay in minutes. Omit unless requested."),
  }),
  z.object({
    type: z.literal("single"),
    at: z
      .string()
      .describe(
        "Minute-precision local datetime in YYYY-MM-DDTHH:mm format without offset or fractional seconds.",
      ),
    timezone: timezoneSchema.optional(),
  }),
]);

export function createScheduleCollectionToolDynamicDefinition(
  definition: ScheduleCollectionDefinition,
  input: { readonly application: string; readonly collection: string },
) {
  return markDynamicCallbackRebind(
    defineDynamic({
      events: {
        "turn.started": async (_event, context) => {
          if (definition.tools === false || contextStorage.getStore()?.has(ScheduleOriginKey))
            return null;
          const client = await bindScheduleCollection(
            input.collection,
            definition,
            bindingContext(input.application, context),
          );
          if (client === null) return null;

          const description = (value: string) =>
            definition.description === undefined ? value : `${definition.description}\n\n${value}`;
          const tools = {
            [`schedule__${input.collection}__create`]: defineTool({
              approval: always(),
              description: description("Schedule an agent request to run at a future time."),
              inputSchema: z.object({
                expression: expressionSchema,
                name: scheduleNameSchema,
                request: z
                  .string()
                  .min(1)
                  .max(2_000)
                  .describe(
                    "The task the agent should perform when this schedule fires. Timing is set by expression; do not ask it to create another schedule.",
                  ),
              }),
              execute: async ({ expression, name, request }) => {
                assertScheduleManagementAllowed();
                return await client.create({
                  expression: expression as ScheduleExpression,
                  name,
                  payload: request,
                });
              },
            }),
            [`schedule__${input.collection}__list`]: defineTool({
              description: description(
                "List schedules in this collection for the current scope. When asked to remove several schedules, collect their names and delete them together in one delete call.",
              ),
              inputSchema: z.object({
                cursor: z.string().optional().describe("Pagination cursor from a prior list call."),
                limit: z.number().int().optional(),
              }),
              execute: async (toolInput) => {
                assertScheduleManagementAllowed();
                return await client.list(toolInput);
              },
            }),
            [`schedule__${input.collection}__delete`]: defineTool({
              approval: always(),
              description: description(
                "Permanently delete one or more schedules from this collection. Provide every schedule name to remove in one request.",
              ),
              inputSchema: z
                .object({
                  names: z
                    .array(scheduleNameSchema)
                    .min(1)
                    .max(25)
                    .describe(
                      "Names of schedules to permanently delete. Duplicate names are ignored.",
                    ),
                })
                .strict(),
              execute: async ({ names }) => {
                assertScheduleManagementAllowed();
                return { results: await client.delete(names) };
              },
            }),
          };
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

function assertScheduleManagementAllowed(): void {
  if (contextStorage.getStore()?.has(ScheduleOriginKey)) {
    throw new Error("Schedule management is unavailable during scheduled execution.");
  }
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
