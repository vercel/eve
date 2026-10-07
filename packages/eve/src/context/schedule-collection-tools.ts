import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { z } from "#compiled/zod/index.js";
import { isDeepStrictEqual } from "node:util";
import type {
  ApprovalContext,
  ApprovalPolicy,
  ApprovalResponsePolicy,
} from "#approval/definition.js";
import { loadContext, contextStorage } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { readSessionSchedule } from "#context/session-schedule.js";
import { defineDynamic } from "#dynamic/definition.js";
import { isApprovalRecheck } from "#harness/approval-recheck.js";
import { markDynamicCallbackRebind } from "#internal/dynamic-tool-rebind.js";
import { bindScheduleCollection, schedules } from "#public/experimental/schedules/client.js";
import type {
  ScheduleOperation,
  ScheduleSubscriptionDefinition,
} from "#public/schedules/subscription.js";
import {
  assertScheduleManagementAllowed,
  type PreparedScheduleCreate,
} from "#runtime/schedules/collection-client.js";
import { scheduleDisplayName } from "#runtime/schedules/record.js";
import { MAX_SCHEDULE_DELAY_MINUTES } from "#runtime/schedules/validation.js";
import { parseJsonObject } from "#shared/json.js";
import { scheduleCollectionToolPrefix } from "#shared/schedule-collection-tools.js";
import { always } from "#tools/approval/policies.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import type { DynamicToolEntry } from "#tools/dynamic.js";
import {
  readDurableDynamicToolCallbacks,
  stampDurableDynamicToolCallbacks,
} from "#tools/durable-callbacks.js";

// Approval must retain prepared data across durable suspension, not in a resolver closure.
const PreparedCreatesKey = new ContextKey<Readonly<Record<string, PreparedScheduleCreate>>>(
  "eve.schedulePreparedCreates",
);
const nameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[0-9A-Za-z][0-9A-Za-z._-]*$/)
  .describe("Readable display label; it may repeat. Creation returns a unique management name.");
const nameInput = z
  .object({
    name: z
      .string()
      .min(1)
      .max(256)
      .describe("Exact unique management name returned by create/get/list, not the display label."),
  })
  .strict();
const timezoneSchema = z
  .string()
  .describe("IANA timezone; omission means UTC. Delays need no timezone.");
const expressionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cron"),
      cron: z.string().describe("Five-field cron: minute hour day-of-month month day-of-week."),
      timezone: timezoneSchema.optional(),
      jitter: z.number().int().min(1).max(15).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("single"),
      at: z.string().describe("Local YYYY-MM-DDTHH:mm, without offset or fractions."),
      timezone: timezoneSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("delay"),
      minutes: z.number().int().min(1).max(MAX_SCHEDULE_DELAY_MINUTES),
    })
    .strict(),
]);
const timingGuidance =
  "For relative requests use expression { type: 'delay', minutes: 1 }; eve resolves timing after approval and rounds up to minute precision (up to 59 seconds later). Do not guess the clock or ask for a timezone for delays.";

export function createScheduleCollectionToolDynamicDefinition<TInput, TPrepared = TInput>(
  definition: ScheduleSubscriptionDefinition<TInput, StandardSchemaV1<unknown, TInput>, TPrepared>,
  identity: { readonly application: string; readonly collection: string },
) {
  return markDynamicCallbackRebind(
    defineDynamic({
      events: {
        "turn.started": async (_event, context) => {
          const scope = contextStorage.getStore();
          if (
            definition.tool === false ||
            context.session.schedule !== undefined ||
            (scope !== undefined && readSessionSchedule(scope) !== undefined)
          )
            return null;
          const prefix = `${scheduleCollectionToolPrefix(identity.collection)}__`;
          const keyFor = (callId: string) => `${prefix}create:${callId}`;
          const createSchema = z
            .object({ name: nameSchema, expression: expressionSchema, payload: definition.schema })
            .strict();
          const createPolicy = definition.approval?.create ?? always();
          const createApproval: { request: ApprovalPolicy; response?: ApprovalResponsePolicy } = {
            request: async (context) => {
              try {
                const input = await createSchema.parseAsync(context.toolInput);
                const prepared = await (
                  await bindScheduleCollection(definition as never)
                ).prepareCreate(input);
                const key = keyFor(context.callId);
                const previous = loadContext().get(PreparedCreatesKey) ?? {};
                if (isApprovalRecheck(context)) {
                  if (previous[key] === undefined || !isDeepStrictEqual(previous[key], prepared))
                    return {
                      type: "denied",
                      reason:
                        "The prepared schedule changed or its approval expired. Request a new creation approval.",
                    };
                } else {
                  const snapshots = {
                    ...Object.fromEntries(
                      Object.entries(previous)
                        .filter(([existing]) => existing !== key)
                        .slice(-31),
                    ),
                    [key]: prepared,
                  };
                  // Evicted approvals fail closed instead of blocking future creation forever.
                  while (Buffer.byteLength(JSON.stringify(snapshots)) > 512 * 1024)
                    delete snapshots[Object.keys(snapshots)[0]!];
                  loadContext().set(PreparedCreatesKey, snapshots);
                }
                const routed = {
                  ...context,
                  toolInput: { ...input, payload: prepared.envelope.payload },
                  payload: prepared.envelope.payload as NoInfer<TPrepared>,
                };
                return typeof createPolicy === "function"
                  ? await createPolicy(routed)
                  : await createPolicy.request(routed);
              } catch (error) {
                return {
                  type: "denied",
                  reason: error instanceof Error ? error.message : "Schedule preparation failed.",
                };
              }
            },
          };
          if (typeof createPolicy !== "function" && createPolicy.response !== undefined) {
            createApproval.response = async (context) => {
              const prepared =
                loadContext().get(PreparedCreatesKey)?.[keyFor(context.request.callId)];
              if (prepared === undefined)
                return {
                  status: "rejected",
                  reason: "The prepared schedule approval expired. Request creation again.",
                };
              return await createPolicy.response!({
                ...context,
                request: {
                  ...context.request,
                  toolInput: { ...context.request.toolInput, payload: prepared.envelope.payload },
                },
                payload: prepared.envelope.payload as NoInfer<TPrepared>,
              });
            };
          }
          const define = (
            operation: ScheduleOperation,
            action: string,
            description: string,
            inputSchema: any,
            execute: ToolDefinition<any, unknown>["execute"],
          ) => {
            const approval =
              operation === "create"
                ? createApproval
                : (definition.approval?.[operation] ??
                  (operation === "get" || operation === "list" ? undefined : always()));
            const tool = defineTool({
              description: `${definition.description ? `${definition.description}\n\n` : ""}${description}`,
              inputSchema,
              approval,
              label: {
                start: (input: { name?: string }) =>
                  input.name ? `${action}: ${scheduleDisplayName(input.name)}` : action,
              },
              execute: (input: any, context) => {
                assertScheduleManagementAllowed();
                return execute(input, context);
              },
            });
            stampCallbacks(tool);
            return tool as DynamicToolEntry;
          };
          return {
            [`${prefix}create`]: define(
              "create",
              "Create schedule",
              `Create future work, not an immediate action. The display name may repeat; use the returned unique name for management. ${timingGuidance} Preparation validates the destination before approval; a changed prepared payload requires fresh approval.`,
              createSchema,
              async (input, context) => {
                const key = keyFor(context.callId);
                const approved = loadContext().get(PreparedCreatesKey)?.[key];
                if (approved === undefined)
                  throw new Error(
                    "Schedule creation has no prepared approval snapshot. Request creation again.",
                  );
                const created = await (
                  await bindScheduleCollection(definition as never)
                ).create(input, approved);
                const snapshots = { ...loadContext().get(PreparedCreatesKey) };
                delete snapshots[key];
                loadContext().set(PreparedCreatesKey, snapshots);
                return created;
              },
            ),
            [`${prefix}get`]: define(
              "get",
              "Read schedule",
              "Read timing/state; stored payload is not returned.",
              nameInput,
              async ({ name }) => await (await schedules(definition as never)).get(name),
            ),
            [`${prefix}list`]: define(
              "list",
              "List schedules",
              "List identity, timing/state, and timestamps; payload is not returned.",
              z
                .object({
                  cursor: z.string().optional(),
                  limit: z.number().int().min(1).max(100).optional(),
                })
                .strict(),
              async (input) => await (await schedules(definition as never)).list(input),
            ),
            [`${prefix}enable`]: define(
              "enable",
              "Enable schedule",
              "Enable future occurrences.",
              nameInput,
              async ({ name }) => await (await schedules(definition as never)).enable(name),
            ),
            [`${prefix}disable`]: define(
              "disable",
              "Disable schedule",
              "Disable future occurrences; already started work is not cancelled.",
              nameInput,
              async ({ name }) => await (await schedules(definition as never)).disable(name),
            ),
            [`${prefix}invoke`]: define(
              "invoke",
              "Run schedule",
              "Enqueue an extra occurrence as the original creator; acceptance is not execution success.",
              nameInput,
              async ({ name }) => {
                await (await schedules(definition as never)).invoke(name);
                return { accepted: true };
              },
            ),
            [`${prefix}delete`]: define(
              "delete",
              "Delete schedule",
              "Delete a schedule; already started work is not cancelled.",
              nameInput,
              async ({ name }) => ({
                deleted: await (await schedules(definition as never)).delete(name),
              }),
            ),
          };
        },
      },
    }),
  );
}

function stampCallbacks(tool: ToolDefinition<any, unknown>): void {
  const closure = parseJsonObject({});
  const existing = readDurableDynamicToolCallbacks(tool);
  const callbacks: Parameters<typeof stampDurableDynamicToolCallbacks>[1] = {
    ...existing,
    execute: {
      callback: async (_closure, input, context) => await tool.execute(input, context),
      closure,
    },
    inputSchema: { callback: () => tool.inputSchema, closure },
    label: { start: { callback: (_closure, input) => tool.label!.start(input), closure } },
  };
  if (tool.approval !== undefined) {
    const approval = tool.approval;
    callbacks.approvalRequest = {
      callback: async (_closure, context) =>
        typeof approval === "function"
          ? await approval(context as ApprovalContext)
          : await approval.request(context as ApprovalContext),
      closure,
    };
    if (typeof approval !== "function" && approval.response !== undefined)
      callbacks.approvalResponse = {
        callback: async (_closure, context) => await approval.response!(context),
        closure,
      };
  }
  stampDurableDynamicToolCallbacks(tool, callbacks);
}
