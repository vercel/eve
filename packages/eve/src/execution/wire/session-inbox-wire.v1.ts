import type { DataContent } from "ai";
import { z } from "#compiled/zod/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import { inputRequestSchema, inputResponseSchema } from "#shared/input.js";
import { formatValidationError } from "#runtime/validation.js";
import { jsonObjectSchema, jsonValueSchema } from "#shared/json-schemas.js";
import { tokenUsageSchema } from "#shared/token-usage.js";
import type { TaskView } from "#tasks/types.js";

const providerOptionsSchema = z.record(z.string(), jsonObjectSchema);
const textPartSchema = z
  .object({
    providerOptions: providerOptionsSchema.optional(),
    text: z.string(),
    type: z.literal("text"),
  })
  .strict();
const binaryDataSchema = z.custom<DataContent | URL>(
  (value) =>
    typeof value === "string" ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    value instanceof URL,
  "Expected a string, URL, Uint8Array, or ArrayBuffer.",
);
const imagePartSchema = z
  .object({
    image: binaryDataSchema,
    mediaType: z.string().optional(),
    providerOptions: providerOptionsSchema.optional(),
    type: z.literal("image"),
  })
  .strict();
const filePartSchema = z
  .object({
    data: binaryDataSchema,
    filename: z.string().optional(),
    mediaType: z.string(),
    providerOptions: providerOptionsSchema.optional(),
    type: z.literal("file"),
  })
  .strict();
const userContentSchema = z.union([
  z.string(),
  z.array(z.discriminatedUnion("type", [textPartSchema, imagePartSchema, filePartSchema])),
]);

const eventCoordinateSchema = z.number().int().nonnegative();
const opaqueObjectSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "Expected an object.",
);
const subagentInputRequestHookPayloadSchema = z
  .object({
    callId: z.string(),
    childContinuationToken: z.string(),
    childSessionId: z.string(),
    event: z
      .object({
        requests: z.array(inputRequestSchema),
        sequence: eventCoordinateSchema,
        stepIndex: eventCoordinateSchema,
        turnId: z.string(),
      })
      .strict(),
    kind: z.literal("subagent-input-request"),
    subagentName: z.string(),
  })
  .strict();
const subagentAuthorizationEventHookPayloadSchema = z
  .object({
    callId: z.string(),
    childSessionId: z.string(),
    event: opaqueObjectSchema,
    kind: z.literal("subagent-authorization-event"),
    subagentName: z.string(),
  })
  .strict();
const taskMetadataSchema = z.union([
  z
    .object({
      agentId: z.string(),
      kind: z.literal("subagent"),
      mode: z.enum(["local", "remote"]),
      name: z.string(),
    })
    .strict(),
  z.object({ kind: z.string(), name: z.string() }).strict(),
]);
const taskExecutorSchema = z
  .object({
    binding: z
      .object({
        data: z.record(z.string(), jsonValueSchema),
        kind: z.string(),
      })
      .strict()
      .optional(),
    childSessionId: z.string().optional(),
    childTurnId: z.string().optional(),
    lifecycle: z.enum(["parked", "terminal"]).optional(),
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
const taskPayloadSchema = z
  .object({
    authorizationEvents: z
      .array(
        z
          .object({
            hookPayload: subagentAuthorizationEventHookPayloadSchema,
            taskId: z.string(),
          })
          .strict(),
      )
      .optional(),
    inputRequests: z
      .array(
        z
          .object({ hookPayload: subagentInputRequestHookPayloadSchema, taskId: z.string() })
          .strict(),
      )
      .optional(),
    views: z.array(taskViewSchema).optional(),
  })
  .strict();

/**
 * The complete eve-owned payload contract. Adapter fields are the explicit
 * extension point and pass through unchanged; changing any declared field is
 * a session-inbox wire-version change.
 */
const deliverPayloadSchema = z
  .object({
    context: z.array(z.string()).optional(),
    inputResponses: z.array(inputResponseSchema).optional(),
    message: userContentSchema.optional(),
    outputSchema: jsonObjectSchema.optional(),
    task: taskPayloadSchema.optional(),
  })
  .loose();

const authSchema = z
  .object({
    attributes: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    authenticator: z.string(),
    issuer: z.string().optional(),
    principalId: z.string(),
    principalType: z.string(),
    subject: z.string().optional(),
  })
  .strict();
const activityWorkIdentitySchema = z
  .object({
    callId: z.string().optional(),
    id: z.string(),
    kind: z.enum(["root-turn", "subagent", "remote-agent", "task"]),
    name: z.string().optional(),
    parentId: z.string().optional(),
    rootSessionId: z.string(),
    rootTurnId: z.string(),
    sessionId: z.string().optional(),
    turnId: z.string().optional(),
  })
  .strict();
const callerSchema = z
  .object({
    activityObserver: z
      .object({
        sink: z.object({ url: z.string(), version: z.literal(1) }).strict(),
        workIdentity: activityWorkIdentitySchema.optional(),
      })
      .strict()
      .optional(),
    callId: z.string(),
    replyTo: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("hook"), token: z.string() }).strict(),
      z.object({ kind: z.literal("callback"), token: z.string(), url: z.string() }).strict(),
    ]),
    subagentName: z.string(),
    taskId: z.string().optional(),
  })
  .strict();
const traceContextSchema = z
  .object({ spanId: z.string(), traceFlags: z.number(), traceId: z.string() })
  .strict();
const deliveryMetadataSchema = z
  .object({
    channelKind: z.string(),
    channelName: z.string(),
    deliveryId: z.string(),
    payloadIndex: z.number().int().nonnegative(),
    requestId: z.string().optional(),
    requestTraceContext: traceContextSchema.optional(),
  })
  .strict();
const VERSION = 1;
const version = z.literal(VERSION);

/** The complete schema for persisted session-inbox wire version 1. */
export const sessionInboxWireV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      auth: authSchema.nullable().optional(),
      caller: callerSchema.optional(),
      deliveryMetadata: z.array(deliveryMetadataSchema).optional(),
      kind: z.literal("deliver"),
      payload: deliverPayloadSchema.optional(),
      payloads: z.array(deliverPayloadSchema),
      requestId: z.string().optional(),
      taskDeliveryId: z.string().optional(),
      turnPolicy: z.enum(["queue", "steer"]).optional(),
      version,
    })
    .strict(),
  z.object({ kind: z.literal("session-timeout"), version }).strict(),
  z.object({ kind: z.literal("clear"), version }).strict(),
  z.object({ kind: z.literal("compact"), version }).strict(),
  z.object({ kind: z.literal("reset"), reason: z.string().optional(), version }).strict(),
  z
    .object({
      kind: z.literal("cancel"),
      taskId: z.string().optional(),
      turnId: z.string().optional(),
      version,
    })
    .strict(),
]);

export type SessionInboxWireV1 = z.infer<typeof sessionInboxWireV1Schema>;

/** Builds and validates one complete version-1 wire value. */
export function encodeSessionCommandV1(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): SessionInboxWireV1 {
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
  const parsed = sessionInboxWireV1Schema.safeParse(wire);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version ${VERSION}: ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}
