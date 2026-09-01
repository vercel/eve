import { z } from "#compiled/zod/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import { normalizeSessionInboxWireV2 } from "#execution/wire/session-inbox-wire.v2-migration.js";
import { sessionInboxWireV2Schema } from "#execution/wire/session-inbox-wire.v2.js";
import { formatValidationError } from "#runtime/validation.js";

const v2 = sessionInboxWireV2Schema.options;
const v2Deliver = v2[0];
const v2DeliveryMetadata = v2Deliver.shape.deliveryMetadata.unwrap().element;
const version = z.literal(3);

/** Version 3 adds the trusted deployment that accepted each channel delivery. */
export const sessionInboxWireV3Schema = z.discriminatedUnion("kind", [
  v2Deliver.extend({
    deliveryMetadata: z
      .array(v2DeliveryMetadata.extend({ acceptedDeploymentId: z.string().optional() }))
      .optional(),
    version,
  }),
  v2[1].extend({ version }),
  v2[2].extend({ version }),
  v2[3].extend({ version }),
  v2[4].extend({ version }),
  v2[5].extend({ version }),
]);

export type SessionInboxWireV3 = z.infer<typeof sessionInboxWireV3Schema>;

export function parseSessionInboxWireV3(value: unknown) {
  return sessionInboxWireV3Schema.safeParse(normalizeSessionInboxWireV2(value));
}

/** Builds and validates one complete version-3 wire value. */
export function encodeSessionCommandV3(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): SessionInboxWireV3 {
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
          version: 3 as const,
        }
      : command.kind === "deliver"
        ? {
            ...command,
            payload: coalesceDeliverPayloads(command.payloads),
            version: 3 as const,
          }
        : { ...command, version: 3 as const };
  const parsed = parseSessionInboxWireV3(wire);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version 3: ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}
