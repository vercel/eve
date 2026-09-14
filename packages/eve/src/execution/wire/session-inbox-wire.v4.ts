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
import { runtimeSubagentChildResultSchema } from "#shared/action-types.js";
import { jsonValueSchema } from "#shared/json-schemas.js";
import { tokenUsageSchema } from "#shared/token-usage.js";
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
  usage: tokenUsageSchema.optional(),
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
const taskPayloadV4Schema = z
  .object({
    agentRequests: z.array(taskAgentRequestSchema).optional(),
    authorizationEvents: z.array(taskAuthorizationEventSchema).optional(),
    inputRequests: z.array(taskInputRequestSchema).optional(),
    views: z.array(taskViewSchema).optional(),
  })
  .strict();

const v3 = sessionInboxWireV3Schema.options;
const v3Deliver = v3[0];
const deliverPayloadV4Schema = v3Deliver.shape.payload.extend({
  task: taskPayloadV4Schema.optional(),
});
const VERSION = 4;
const version = z.literal(VERSION);

/** Version 4 replaces executor-specific task envelopes with typed workflow-run requests. */
export const sessionInboxWireV4Schema = z.discriminatedUnion("kind", [
  v3Deliver.extend({
    payload: deliverPayloadV4Schema,
    payloads: z.array(deliverPayloadV4Schema),
    version,
  }),
  v3[1].extend({ version }),
  v3[2].extend({ version }),
  v3[3].extend({ version }),
  v3[4].extend({ version }),
  v3[5].extend({ version }),
]);

export type SessionInboxWireV4 = z.infer<typeof sessionInboxWireV4Schema>;

/** Builds and validates one complete version-4 wire value. */
export function encodeSessionCommandV4(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): SessionInboxWireV4 {
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
  const parsed = sessionInboxWireV4Schema.safeParse(wire);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version ${VERSION}: ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}
