import { z } from "#compiled/zod/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWireV6Schema } from "#execution/wire/session-inbox-wire.v6.js";
import { formatValidationError } from "#runtime/validation.js";

const v6 = sessionInboxWireV6Schema.options;
const v6Deliver = v6[0];
const v6Payload = v6Deliver.shape.payload;
const v6Task = v6Payload.shape.task.unwrap();
const v6AgentRequest = v6Task.shape.agentRequests.unwrap().element;
const v6AgentInvocationRequest = v6AgentRequest.shape.request.options[0];
const v6AgentSettlementRequest = v6AgentRequest.shape.request.options[1];
const taskAgentRequestV7Schema = v6AgentRequest.extend({
  request: z.discriminatedUnion("kind", [
    v6AgentInvocationRequest.extend({ parentActionCallId: z.string().optional() }),
    v6AgentSettlementRequest,
  ]),
});
const taskPayloadV7Schema = v6Task.extend({
  agentRequests: z.array(taskAgentRequestV7Schema).optional(),
});
const deliverPayloadV7Schema = v6Payload.extend({ task: taskPayloadV7Schema.optional() });
const VERSION = 7;
const version = z.literal(VERSION);

/** Version 7 binds workflow agent requests to their instrumented outer action. */
export const sessionInboxWireV7Schema = z.discriminatedUnion("kind", [
  v6Deliver.extend({
    payload: deliverPayloadV7Schema,
    payloads: z.array(deliverPayloadV7Schema),
    version,
  }),
  v6[1].extend({ version }),
  v6[2].extend({ version }),
  v6[3].extend({ version }),
  v6[4].extend({ version }),
  v6[5].extend({ version }),
]);

export type SessionInboxWireV7 = z.infer<typeof sessionInboxWireV7Schema>;

export function encodeSessionCommandV7(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): SessionInboxWireV7 {
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
  const parsed = sessionInboxWireV7Schema.safeParse(wire);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version ${VERSION}: ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}
