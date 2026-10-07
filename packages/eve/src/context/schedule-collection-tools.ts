import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { z } from "#compiled/zod/index.js";
import {
  resolveApprovalPolicy,
  type Approval,
  type ApprovalConfiguration,
} from "#approval/definition.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, ScheduleIdKey } from "#context/keys.js";
import { defineDynamic } from "#dynamic/definition.js";
import { sameResponder } from "#harness/approval-candidates.js";
import { isApprovalRecheck, markApprovalRecheck } from "#harness/approval-recheck.js";
import { markDynamicCallbackRebind } from "#internal/dynamic-tool-rebind.js";
import { schedules } from "#public/experimental/schedules/client.js";
import type {
  ScheduleOperation,
  ScheduleSubscriptionDefinition,
} from "#public/schedules/subscription.js";
import { assertScheduleManagementAllowed } from "#runtime/schedules/collection-client.js";
import { scheduleDisplayName } from "#runtime/schedules/record.js";
import { MAX_SCHEDULE_DELAY_MINUTES, validateScheduleName } from "#runtime/schedules/validation.js";
import { parseJsonObject } from "#shared/json.js";
import { scheduleCollectionToolPrefix } from "#shared/schedule-collection-tools.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import {
  readDurableDynamicToolCallbacks,
  stampDurableDynamicToolCallbacks,
} from "#tools/durable-callbacks.js";

const actions: Record<ScheduleOperation, string> = {
  create: "Create schedule",
  get: "Read schedule",
  list: "List schedules",
  enable: "Enable schedule",
  disable: "Disable schedule",
  invoke: "Run schedule",
  delete: "Delete schedule",
};
const timingGuidance =
  "For relative requests use expression { type: 'delay', minutes: 1 }. eve resolves the time when the approved operation executes, rounding up to minute precision (up to 59 seconds later). Do not guess the clock, sleep, or ask for a timezone for a delay. For absolute/recurring times use single/cron and clarify ambiguous local timezones.";
const timezoneSchema = z
  .string()
  .describe("IANA timezone; omission means UTC. Relative delays need no timezone.");
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

export function createScheduleCollectionToolDynamicDefinition<TPayload, TPrepared = TPayload>(
  definition: ScheduleSubscriptionDefinition<
    TPayload,
    StandardSchemaV1<unknown, TPayload>,
    TPrepared
  >,
  identity: { readonly application: string; readonly collection: string },
) {
  return markDynamicCallbackRebind(
    defineDynamic({
      events: {
        "turn.started": async (_event, context) => {
          const auth = context.session.auth.current;
          if (
            definition.tools === false ||
            auth?.attributes["eve.scheduled_run"] === "true" ||
            (Array.isArray(auth?.attributes["eve.scheduled_run"]) &&
              auth.attributes["eve.scheduled_run"].includes("true")) ||
            contextStorage.getStore()?.get(ScheduleIdKey) !== undefined
          )
            return null;

          const toolName = `${scheduleCollectionToolPrefix(identity.collection)}__manage`;
          const inputSchema = z
            .object({
              operation: z.enum(["create", "get", "list", "enable", "disable", "invoke", "delete"]),
              name: z
                .string()
                .min(1)
                .max(256)
                .optional()
                .describe(
                  "For create: readable display label, which may repeat. Otherwise: exact unique management name returned by create/get/list.",
                ),
              expression: expressionSchema.optional().describe("Required only for create."),
              payload: z
                .optional(definition.schema as any)
                .describe("Required only for create; omit for every other operation."),
              cursor: z.string().optional().describe("Pagination cursor for list only."),
              limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .describe("Page size for list only."),
            })
            .strict()
            .superRefine((input, ctx) => {
              const allowed =
                input.operation === "create"
                  ? ["operation", "name", "expression", "payload"]
                  : input.operation === "list"
                    ? ["operation", "cursor", "limit"]
                    : ["operation", "name"];
              for (const key of Object.keys(input)) {
                if (!allowed.includes(key) && input[key as keyof typeof input] !== undefined)
                  ctx.addIssue({
                    code: "custom",
                    path: [key],
                    message: `${key} is not supported for ${input.operation}.`,
                  });
              }
              if (input.operation !== "list" && input.name === undefined)
                ctx.addIssue({
                  code: "custom",
                  path: ["name"],
                  message: `${input.operation} requires a name.`,
                });
              if (input.operation === "create") {
                if (input.expression === undefined)
                  ctx.addIssue({
                    code: "custom",
                    path: ["expression"],
                    message: "create requires expression.",
                  });
                if (input.payload === undefined)
                  ctx.addIssue({
                    code: "custom",
                    path: ["payload"],
                    message: "create requires payload.",
                  });
                if (input.name !== undefined) {
                  try {
                    validateScheduleName(input.name);
                  } catch (error) {
                    ctx.addIssue({
                      code: "custom",
                      path: ["name"],
                      message: (error as Error).message,
                    });
                  }
                }
              }
            });
          const defaultMutationApproval = always();
          const policyFor = (operation: ScheduleOperation): Approval | undefined =>
            definition.tools === false
              ? undefined
              : (definition.tools?.approval?.[operation] ??
                (operation === "get" || operation === "list"
                  ? undefined
                  : defaultMutationApproval));
          const approvalKey = (operation: ScheduleOperation) => `${toolName}:${operation}`;
          const tool = defineTool({
            description: `${definition.description ? `${definition.description}\n\n` : ""}Manage schedules using create, get, list, enable, disable, invoke, or delete. Create stores a future task, not an immediate action; its display name may repeat, and its receipt returns a unique management name. ${timingGuidance} Get/list omit stored payload and creator data. Invoke queues an additional occurrence as the original creator, not proof of execution success. Disable/delete do not cancel started work. Timing and payload are immutable; replacement requires explicit create/delete.`,
            inputSchema,
            label: {
              start: (input) =>
                input.name
                  ? `${actions[input.operation]}: ${scheduleDisplayName(input.name)}`
                  : actions[input.operation],
            },
            approvalKey: (input) => approvalKey(input.operation),
            approval: {
              request: async (context) => {
                const parsed = await inputSchema.safeParseAsync(context.toolInput);
                if (!parsed.success)
                  return {
                    type: "denied",
                    reason: parsed.error.issues.map((issue) => issue.message).join("; "),
                  };
                const policy = policyFor(parsed.data.operation);
                if (policy === undefined) return "not-applicable";
                // once() must apply to one operation, not every mutation sharing the tool name.
                const approvedTools = new Set(context.approvedTools);
                approvedTools.delete(toolName);
                if (context.approvedTools.has(approvalKey(parsed.data.operation)))
                  approvedTools.add(toolName);
                const routed = { ...context, approvedTools };
                if (isApprovalRecheck(context)) markApprovalRecheck(routed);
                return await resolveApprovalPolicy(policy)(routed);
              },
              response: async (context) => {
                const parsed = await inputSchema.safeParseAsync(context.request.toolInput);
                if (!parsed.success)
                  return {
                    status: "rejected",
                    reason: "The schedule management input is invalid.",
                  };
                const policy = policyFor(parsed.data.operation);
                if (typeof policy !== "function" && policy?.response)
                  return await policy.response(context);
                const requester = context.request.principal;
                return requester === null || sameResponder(requester, context.response.principal)
                  ? { status: "allowed" }
                  : {
                      status: "rejected",
                      reason:
                        "Only the person who requested this action can respond to this approval.",
                    };
              },
            },
            async execute(rawInput) {
              assertScheduleManagementAllowed(contextStorage.getStore()?.get(AuthKey) ?? null);
              const input = await inputSchema.parseAsync(rawInput);
              const client = await schedules(definition as never);
              switch (input.operation) {
                case "create":
                  return await client.create({
                    name: input.name!,
                    expression: input.expression!,
                    payload: input.payload!,
                  });
                case "get":
                  return await client.get(input.name!);
                case "list":
                  return await client.list({ cursor: input.cursor, limit: input.limit });
                case "enable":
                  return await client.enable(input.name!);
                case "disable":
                  return await client.disable(input.name!);
                case "invoke":
                  await client.invoke(input.name!);
                  return { accepted: true };
                case "delete":
                  return { deleted: await client.delete(input.name!) };
              }
            },
          });
          const closure = parseJsonObject({});
          stampDurableDynamicToolCallbacks(tool, {
            ...readDurableDynamicToolCallbacks(tool),
            execute: {
              callback: async (_closure, input, context) => await tool.execute(input, context),
              closure,
            },
            inputSchema: { callback: async () => tool.inputSchema, closure },
            label: {
              start: { callback: (_closure, input) => tool.label!.start(input), closure },
            },
            approvalKey: { callback: (_closure, input) => tool.approvalKey!(input), closure },
            approvalRequest: {
              callback: async (_closure, context) =>
                await resolveApprovalPolicy(tool.approval!)(context),
              closure,
            },
            approvalResponse: {
              callback: async (_closure, context) =>
                await (tool.approval as ApprovalConfiguration).response!(context),
              closure,
            },
          });
          return { [toolName]: tool };
        },
      },
    }),
  );
}
