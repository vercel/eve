import { always } from "#tools/approval/policies.js";
import type { DynamicResolveContext } from "#dynamic/definition.js";
import { defineDynamic } from "#dynamic/definition.js";
import type {
  ScheduleCollectionDefinition,
  ScheduleExpression,
} from "#public/schedules/collection.js";
import { bindScheduleCollection } from "#runtime/schedules/collection-client.js";
import { defineTool } from "#tools/definition.js";
import { z } from "#compiled/zod/index.js";

const expressionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cron"),
    cron: z.string(),
    timezone: z.string().optional(),
    jitter: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("single"),
    at: z.string(),
    timezone: z.string().optional(),
  }),
]);

export function createScheduleCollectionToolDynamicDefinition<TInput>(
  definition: ScheduleCollectionDefinition<TInput>,
  input: { readonly application: string; readonly collection: string },
) {
  return defineDynamic({
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

        if (options.create) {
          tools[`${input.collection}__create_schedule`] = defineTool({
            approval: always(),
            description: description("Create a recurring or one-time schedule in this collection."),
            inputSchema: z.object({
              expression: expressionSchema,
              input: z.unknown(),
              name: z.string(),
              state: z.enum(["active", "inactive"]).optional(),
            }),
            execute: async (toolInput) =>
              await client.create({
                expression: toolInput.expression as ScheduleExpression,
                input: toolInput.input as TInput,
                name: toolInput.name,
                state: toolInput.state,
              }),
          });
        }
        if (options.read) {
          tools[`${input.collection}__list_schedules`] = defineTool({
            description: description("List schedules in this collection for the current scope."),
            inputSchema: z.object({
              cursor: z.string().optional(),
              limit: z.number().int().optional(),
            }),
            execute: async (toolInput) => await client.list(toolInput),
          });
          tools[`${input.collection}__read_schedule`] = defineTool({
            description: description("Read one schedule in this collection by its exact name."),
            inputSchema: z.object({ name: z.string() }),
            execute: async ({ name }) => await client.get(name),
          });
        }
        if (options.update) {
          tools[`${input.collection}__update_schedule`] = defineTool({
            approval: always(),
            description: description("Update the timing or typed input of an existing schedule."),
            inputSchema: z.object({
              expression: expressionSchema.optional(),
              input: z.unknown().optional(),
              name: z.string(),
            }),
            execute: async ({ name, ...patch }) =>
              await client.update(name, {
                ...(patch.expression === undefined
                  ? {}
                  : { expression: patch.expression as ScheduleExpression }),
                ...(patch.input === undefined ? {} : { input: patch.input as TInput }),
              }),
          });
          tools[`${input.collection}__enable_schedule`] = defineTool({
            approval: always(),
            description: description("Enable an inactive schedule."),
            inputSchema: z.object({ name: z.string() }),
            execute: async ({ name }) => await client.enable(name),
          });
          tools[`${input.collection}__disable_schedule`] = defineTool({
            approval: always(),
            description: description("Disable a schedule without deleting it."),
            inputSchema: z.object({ name: z.string() }),
            execute: async ({ name }) => await client.disable(name),
          });
        }
        if (options.delete) {
          tools[`${input.collection}__delete_schedule`] = defineTool({
            approval: always(),
            description: description("Permanently delete a schedule from this collection."),
            inputSchema: z.object({ name: z.string() }),
            execute: async ({ name }) => ({ deleted: await client.delete(name) }),
          });
        }
        if (options.invoke) {
          tools[`${input.collection}__invoke_schedule`] = defineTool({
            approval: always(),
            description: description("Run a schedule now without changing its timing or state."),
            inputSchema: z.object({ name: z.string() }),
            execute: async ({ name }) => {
              await client.invoke(name);
              return { invoked: true };
            },
          });
        }
        return tools;
      },
    },
  });
}

function bindingContext(application: string, context: DynamicResolveContext) {
  return {
    abortSignal: context.abortSignal ?? new AbortController().signal,
    application,
    channel: context.channel,
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
    return { create: true, delete: true, invoke: false, read: true, update: true };
  }
  return {
    create: tools.create ?? true,
    delete: tools.delete ?? true,
    invoke: tools.invoke ?? false,
    read: tools.read ?? true,
    update: tools.update ?? true,
  };
}
