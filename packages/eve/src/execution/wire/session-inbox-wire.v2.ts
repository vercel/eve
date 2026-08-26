import { z } from "#compiled/zod/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWireV1Schema } from "#execution/wire/session-inbox-wire.v1.js";
import { formatValidationError } from "#runtime/validation.js";

const VERSION = 2;
const version = z.literal(VERSION);
const [deliver, timeout, clear, compact, reset, cancel] = sessionInboxWireV1Schema.options;

/** The complete schema for persisted session-inbox wire version 2. */
export const sessionInboxWireV2Schema = z.discriminatedUnion("kind", [
  deliver.omit({ version: true }).extend({ agentNodeId: z.string().optional(), version }).strict(),
  timeout.omit({ version: true }).extend({ version }).strict(),
  clear.omit({ version: true }).extend({ version }).strict(),
  compact.omit({ version: true }).extend({ version }).strict(),
  reset.omit({ version: true }).extend({ version }).strict(),
  cancel.omit({ version: true }).extend({ version }).strict(),
]);

export type SessionInboxWireV2 = z.infer<typeof sessionInboxWireV2Schema>;

/** Builds and validates one complete version-2 wire value. */
export function encodeSessionCommandV2(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): SessionInboxWireV2 {
  const wire =
    command.kind === "send"
      ? {
          agentNodeId: command.agentNodeId,
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
  const parsed = sessionInboxWireV2Schema.safeParse(wire);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version ${VERSION}: ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}
