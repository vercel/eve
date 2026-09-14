import { z } from "#compiled/zod/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWireV3Schema } from "#execution/wire/session-inbox-wire.v3.js";
import { formatValidationError } from "#runtime/validation.js";
import { jsonValueSchema } from "#shared/json-schemas.js";
import { tokenUsageWithCostSchema } from "#shared/token-usage.js";
import type { TaskView } from "#tasks/types.js";

const taskMetadataSchema = z
  .object({
    agentId: z.string().optional(),
    kind: z.string(),
    mode: z.enum(["local", "remote"]).optional(),
    name: z.string(),
  })
  .strict();
const taskExecutorSchema = z
  .object({
    binding: z
      .object({
        data: z.record(z.string(), jsonValueSchema),
        kind: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
const taskViewBase = {
  executor: taskExecutorSchema.optional(),
  metadata: taskMetadataSchema,
  taskId: z.string(),
  usage: tokenUsageWithCostSchema.optional(),
};
const taskViewSchema: z.ZodType<TaskView> = z.discriminatedUnion("status", [
  z.object({ ...taskViewBase, status: z.literal("working") }).strict(),
  z
    .object({
      ...taskViewBase,
      inputRequests: z.array(jsonValueSchema),
      status: z.literal("input_required"),
    })
    .strict(),
  z
    .object({
      ...taskViewBase,
      lastOutput: z.object({ data: jsonValueSchema, type: z.literal("result") }).strict(),
      status: z.literal("completed"),
    })
    .strict(),
  z
    .object({
      ...taskViewBase,
      lastOutput: z.object({ data: jsonValueSchema, type: z.literal("error") }).strict(),
      status: z.literal("failed"),
    })
    .strict(),
  z.object({ ...taskViewBase, status: z.literal("cancelled") }).strict(),
]);
const eventCoordinateSchema = z.number().int().nonnegative();
const taskInputRequestBase = {
  replyTo: z.string(),
  sequence: eventCoordinateSchema,
  stepIndex: eventCoordinateSchema,
  taskId: z.string(),
  turnId: z.string(),
};
const taskInputRequestSchema = z.union([
  z
    .object({
      ...taskInputRequestBase,
      request: jsonValueSchema,
    })
    .loose(),
  z
    .object({
      ...taskInputRequestBase,
      requests: z.array(jsonValueSchema),
    })
    .loose(),
]);
const agentInvocationInputSchema = z
  .object({
    agentId: z.string().optional(),
    message: z.string(),
    outputSchema: z.record(z.string(), jsonValueSchema).optional(),
    target: z.string(),
  })
  .strict();
const agentTurnResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("succeeded"), output: jsonValueSchema }),
  z.strictObject({ error: jsonValueSchema, kind: z.literal("failed") }),
  z.strictObject({ kind: z.literal("cancelled") }),
]);
const agentTurnOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("parked"),
    result: agentTurnResultSchema,
    usageDelta: tokenUsageWithCostSchema,
  }),
  z.strictObject({
    kind: z.literal("terminal"),
    result: agentTurnResultSchema,
    usageDelta: tokenUsageWithCostSchema,
  }),
]);
const runtimeSubagentChildResultSchema = z
  .object({
    backgroundTask: z.strictObject({ status: z.literal("working"), taskId: z.string() }).optional(),
    callId: z.string(),
    isError: z.boolean().optional(),
    kind: z.literal("subagent-result"),
    origin: z.literal("child"),
    outcome: agentTurnOutcomeSchema,
    output: jsonValueSchema,
    subagentName: z.string(),
    usage: tokenUsageWithCostSchema.optional(),
  })
  .strict();
const taskAgentRequestSchema = z
  .object({
    replyTo: z.string(),
    request: z.discriminatedUnion("kind", [
      z
        .object({
          input: agentInvocationInputSchema,
          invocationId: z.string(),
          kind: z.literal("agent-invoke"),
        })
        .strict(),
      z
        .object({
          kind: z.literal("agent-settled"),
          result: runtimeSubagentChildResultSchema,
        })
        .strict(),
    ]),
    taskId: z.string(),
  })
  .strict();
const subagentAuthorizationEventHookPayloadSchema = z
  .object({
    callId: z.string(),
    childSessionId: z.string(),
    event: z.custom<Record<string, unknown>>(
      (value) => typeof value === "object" && value !== null && !Array.isArray(value),
      "Expected an object.",
    ),
    kind: z.literal("subagent-authorization-event"),
    subagentName: z.string(),
  })
  .strict();
const taskAuthorizationEventSchema = z
  .object({
    hookPayload: subagentAuthorizationEventHookPayloadSchema,
    taskId: z.string(),
  })
  .strict();
const taskPayloadV5Schema = z
  .object({
    agentRequests: z.array(taskAgentRequestSchema).optional(),
    authorizationEvents: z.array(taskAuthorizationEventSchema).optional(),
    inputRequests: z.array(taskInputRequestSchema).optional(),
    views: z.array(taskViewSchema).optional(),
  })
  .strict();

const v3 = sessionInboxWireV3Schema.options;
const v3Deliver = v3[0];
const deliverPayloadV5Schema = v3Deliver.shape.payload.extend({
  task: taskPayloadV5Schema.optional(),
});
const VERSION = 5;
const version = z.literal(VERSION);

/** Version 5 adds model token cost to delegated usage reports. */
export const sessionInboxWireV5Schema = z.discriminatedUnion("kind", [
  v3Deliver.extend({
    payload: deliverPayloadV5Schema,
    payloads: z.array(deliverPayloadV5Schema),
    version,
  }),
  v3[1].extend({ version }),
  v3[2].extend({ version }),
  v3[3].extend({ version }),
  v3[4].extend({ version }),
  v3[5].extend({ version }),
]);

export type SessionInboxWireV5 = z.infer<typeof sessionInboxWireV5Schema>;

/** Builds and validates one complete version-5 wire value. */
export function encodeSessionCommandV5(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): SessionInboxWireV5 {
  const wire =
    command.kind === "send"
      ? {
          auth: command.auth,
          caller: command.caller,
          deliveryMetadata:
            command.delivery === undefined ? undefined : [{ ...command.delivery, payloadIndex: 0 }],
          kind: "deliver" as const,
          payload: command.payload,
          payloads: [command.payload],
          requestId: command.requestId,
          taskDeliveryId: command.taskDeliveryId,
          turnPolicy: command.turnPolicy,
          version: VERSION,
        }
      : command.kind === "deliver"
        ? {
            ...command,
            payload: coalesceDeliverPayloads(command.payloads),
            version: VERSION,
          }
        : { ...command, version: VERSION };
  const parsed = sessionInboxWireV5Schema.safeParse(wire);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version ${VERSION}: ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}
