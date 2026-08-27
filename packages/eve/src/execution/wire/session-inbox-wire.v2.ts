import { z } from "#compiled/zod/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWireV1Schema } from "#execution/wire/session-inbox-wire.v1.js";
import { formatValidationError } from "#runtime/validation.js";
import { isObject } from "#shared/guards.js";

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
const activityObserverSchema = z
  .object({
    sink: z.object({ url: z.string(), version: z.literal(1) }).strict(),
    workIdentity: activityWorkIdentitySchema.optional(),
  })
  .strict();
const v1 = sessionInboxWireV1Schema.options;
const v1Deliver = v1[0];
const v1Caller = v1Deliver.shape.caller.unwrap();
const version = z.literal(2);

/** Version 2 adds activity observer metadata to delegated callers. */
export const sessionInboxWireV2Schema = z.discriminatedUnion("kind", [
  v1Deliver.extend({
    caller: v1Caller.extend({ activityObserver: activityObserverSchema.optional() }).optional(),
    version,
  }),
  v1[1].extend({ version }),
  v1[2].extend({ version }),
  v1[3].extend({ version }),
  v1[4].extend({ version }),
  v1[5].extend({ version }),
]);

export type SessionInboxWireV2 = z.infer<typeof sessionInboxWireV2Schema>;

export const sessionInboxWireV1Migration: VersionMigration = {
  from: 1,
  migrate(prior) {
    return { ...(prior as Record<string, unknown>), version: 2 };
  },
  to: 2,
};

export function parseSessionInboxWireV2(value: unknown) {
  return sessionInboxWireV2Schema.safeParse(normalizeWireValue(value));
}

/** Builds and validates one complete version-2 wire value. */
export function encodeSessionCommandV2(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): SessionInboxWireV2 {
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
          version: 2 as const,
        }
      : command.kind === "deliver"
        ? {
            ...command,
            payload: coalesceDeliverPayloads(command.payloads),
            version: 2 as const,
          }
        : { ...command, version: 2 as const };
  const parsed = parseSessionInboxWireV2(wire);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version 2: ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function normalizeWireValue(value: unknown, arrayFallback = false): unknown {
  if (value === undefined) return arrayFallback ? null : undefined;
  if (Array.isArray(value)) return value.map((item) => normalizeWireValue(item, true));
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .map(([key, item]) => [key, normalizeWireValue(item)]),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === null ||
    prototype === Object.prototype ||
    Object.getPrototypeOf(prototype) === null
  );
}
