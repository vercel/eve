import { MAX_SCHEDULE_DELAY_MINUTES } from "#runtime/schedules/validation.js";
import { z } from "#compiled/zod/index.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, ScheduleIdKey } from "#context/keys.js";
import { defineDynamic } from "#dynamic/definition.js";
import { markDynamicCallbackRebind } from "#internal/dynamic-tool-rebind.js";
import { scheduleCollectionToolPrefix } from "#shared/schedule-collection-tools.js";
import { parseJsonObject } from "#shared/json.js";
import { always } from "#tools/approval/policies.js";
import type { Approval } from "#public/definitions/approval.js";
import { defineTool } from "#tools/definition.js";
import type { DynamicToolEntry } from "#tools/dynamic.js";
import type { ScheduleCollectionDefinition } from "#public/schedules/collection.js";
import { schedules } from "#public/experimental/schedules/client.js";
import { assertScheduleManagementAllowed as assertClientScheduleManagementAllowed } from "#runtime/schedules/collection-client.js";
import {
  readDurableDynamicToolCallbacks,
  stampDurableDynamicToolCallbacks,
} from "#tools/durable-callbacks.js";

const nameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[0-9A-Za-z][0-9A-Za-z._-]*$/u)
  .describe(
    "Stable schedule slug, such as sf-weather. Start with a letter or digit; use only letters, digits, dots, underscores, and dashes. No spaces.",
  );
const timezoneSchema = z
  .string()
  .describe(
    "IANA timezone such as America/Los_Angeles or UTC. Omission means UTC. Ask only when an absolute local time or recurring wall-clock time is ambiguous; never ask for a timezone for a relative delay.",
  );
const timingGuidance =
  "For a relative request such as 'in one minute', use expression { type: 'delay', minutes: 1 }. eve computes the time; do not ask for an absolute time or timezone, guess the clock, or sleep. Delays start when this operation executes and round up to minute precision (up to 59 seconds later). For a specified wall-clock time use single/cron with its timezone; ask only if that timezone is ambiguous.";
const expressionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cron"),
      cron: z
        .string()
        .describe(
          "Five-field cron: minute hour day-of-month month day-of-week. Use for recurring work.",
        ),
      timezone: timezoneSchema.optional(),
      jitter: z
        .number()
        .int()
        .min(1)
        .max(15)
        .optional()
        .describe("Optional maximum random delay in minutes; omit unless requested."),
    })
    .strict(),
  z
    .object({
      type: z.literal("single"),
      at: z
        .string()
        .describe(
          "Absolute local datetime YYYY-MM-DDTHH:mm, minute precision, without offset or fractions. Use delay for relative requests.",
        ),
      timezone: timezoneSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("delay"),
      minutes: z
        .number()
        .int()
        .min(1)
        .max(MAX_SCHEDULE_DELAY_MINUTES)
        .describe(
          "Whole minutes from execution, e.g. 1 for 'in one minute'. No timezone or clock lookup needed.",
        ),
    })
    .strict(),
]);

export function createScheduleCollectionToolDynamicDefinition<TRequest, TMetadata>(
  definition: ScheduleCollectionDefinition<TRequest, TMetadata>,
  identity: { readonly application: string; readonly collection: string },
) {
  return markDynamicCallbackRebind(
    defineDynamic({
      events: {
        "turn.started": async (_event, context) => {
          if (
            definition.tools === false ||
            isScheduledExecution(context.session.auth.current) ||
            contextStorage.getStore()?.get(ScheduleIdKey) !== undefined
          )
            return null;
          const requestSchema =
            definition.request ??
            z
              .string()
              .min(1)
              .max(2000)
              .describe(
                "Task to perform when this schedule fires. Exclude timing and delivery instructions: those are captured separately. Include needed context; the new run does not inherit this conversation. Do not ask it to create another schedule. Only request work supported by available tools.",
              );
          const metadataSchema = definition.metadata;
          const metadataShape = metadataSchema === undefined ? {} : { metadata: metadataSchema };
          const deliveryNames = Object.keys(definition.deliveries) as [string, ...string[]];
          const deliveryShape = {
            deliveries: z
              .array(z.enum(deliveryNames))
              .min(1)
              .describe(
                `Where each result is delivered; at least one is required. Use a destination the user named or clearly implied, such as “reply here” or “DM me”. Ask only when the request does not say where results should go. Available: ${deliveryNames
                  .map((name) => `${name} (${definition.deliveries[name]!.description})`)
                  .join("; ")}.`,
              ),
          };
          const createSchema = z
            .object({
              name: nameSchema,
              expression: expressionSchema,
              request: requestSchema,
              ...metadataShape,
              ...deliveryShape,
            })
            .strict();
          const nameInput = z.object({ name: nameSchema }).strict();
          const listInput = z
            .object({
              cursor: z.string().optional(),
              limit: z.number().int().min(1).max(100).optional(),
            })
            .strict();
          const describe = (text: string) =>
            `${definition.description === undefined ? "" : `${definition.description}\n\n`}${text}`;
          const approval = definition.tools?.approval;
          const policy = (operation: keyof NonNullable<typeof approval>, defaultApproval = false) =>
            approval?.[operation] ?? (defaultApproval ? always() : undefined);
          const define = (
            description: string,
            inputSchema: any,
            run: (input: any) => Promise<unknown>,
            approval?: Approval,
          ): DynamicToolEntry => {
            const entry: {
              approval?: Approval;
              description: string;
              inputSchema: any;
              execute: (input: any) => Promise<unknown>;
            } = {
              description: describe(description),
              inputSchema,
              execute: async (input: any) => {
                assertScheduleManagementAllowed();
                return await run(input);
              },
            };
            if (approval !== undefined) entry.approval = approval;
            return defineTool(entry) as DynamicToolEntry;
          };
          const prefix = `${scheduleCollectionToolPrefix(identity.collection)}__`;
          const operations: Record<string, DynamicToolEntry> = {
            [`${prefix}create`]: define(
              `Create a future agent invocation, not an immediate action. ${timingGuidance} Request content is not available from get/list and cannot be edited later. Deliveries are fixed at creation and cannot be changed; to change them, delete the schedule and create it again. Each delivery receives content the run writes for it.`,
              createSchema,
              async (input) =>
                await (
                  await schedules(definition as never)
                ).create({ ...input, metadata: input.metadata ?? {} }),
              policy("create", true),
            ),
            [`${prefix}get`]: define(
              "Read schedule timing and state. Stored request content and delivery targets are not returned.",
              nameInput,
              async ({ name }) => await (await schedules(definition as never)).get(name),
              policy("get"),
            ),
            [`${prefix}list`]: define(
              "List schedule names, timing, and state. Stored request content and delivery targets are not returned.",
              listInput,
              async (input) => await (await schedules(definition as never)).list(input),
              policy("list"),
            ),
            [`${prefix}update`]: define(
              `Change schedule timing only. ${timingGuidance} Request content and delivery targets cannot be edited.`,
              z.object({ ...nameInput.shape, expression: expressionSchema.optional() }).strict(),
              async ({ name, expression }) =>
                await (
                  await schedules(definition as never)
                ).update(name, expression === undefined ? {} : { expression }),
              policy("update", true),
            ),
            [`${prefix}enable`]: define(
              "Enable future schedule occurrences.",
              nameInput,
              async ({ name }) => await (await schedules(definition as never)).enable(name),
              policy("enable", true),
            ),
            [`${prefix}disable`]: define(
              "Disable future schedule occurrences; already admitted work is not cancelled.",
              nameInput,
              async ({ name }) => await (await schedules(definition as never)).disable(name),
              policy("disable", true),
            ),
            [`${prefix}invoke`]: define(
              "Enqueue an additional occurrence. Acceptance does not mean execution succeeded.",
              nameInput,
              async ({ name }) => {
                await (await schedules(definition as never)).invoke(name);
                return { accepted: true };
              },
              policy("invoke", true),
            ),
            [`${prefix}delete`]: define(
              "Delete a schedule; already admitted work is not cancelled.",
              nameInput,
              async ({ name }) => ({
                deleted: await (await schedules(definition as never)).delete(name),
              }),
              policy("delete", true),
            ),
          };
          for (const tool of Object.values(operations)) stampGeneratedToolCallbacks(tool);
          return operations;
        },
      },
    }),
  );
}

function isScheduledExecution(
  auth: { readonly attributes: Readonly<Record<string, string | readonly string[]>> } | null,
): boolean {
  const value = auth?.attributes["eve.scheduled_run"];
  return value === "true" || (Array.isArray(value) && value.includes("true"));
}

function assertScheduleManagementAllowed(): void {
  assertClientScheduleManagementAllowed(contextStorage.getStore()?.get(AuthKey) ?? null);
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
    inputSchema: { callback: async () => entry.inputSchema, closure },
  };
  stampDurableDynamicToolCallbacks(entry, callbacks);
}
