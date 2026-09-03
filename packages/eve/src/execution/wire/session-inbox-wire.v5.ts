import { z } from "#compiled/zod/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWireV4Schema } from "#execution/wire/session-inbox-wire.v4.js";
import { formatValidationError } from "#runtime/validation.js";

const v4 = sessionInboxWireV4Schema.options;
const v4Deliver = v4[0];
const v4Payload = v4Deliver.shape.payload;
const v4Task = v4Payload.shape.task.unwrap();
const v4AgentRequest = v4Task.shape.agentRequests.unwrap().element;
const v4AgentInvocationRequest = v4AgentRequest.shape.request.options[0];
const v4AgentSettlementRequest = v4AgentRequest.shape.request.options[1];
const taskAgentRequestV5Schema = v4AgentRequest.extend({
  actionCallId: z.string().optional(),
  request: z.discriminatedUnion("kind", [
    v4AgentInvocationRequest.extend({ instrumentationCallId: z.string().optional() }),
    v4AgentSettlementRequest,
  ]),
});
const taskPayloadV5Schema = v4Task.extend({
  agentRequests: z.array(taskAgentRequestV5Schema).optional(),
});
const deliverPayloadV5Schema = v4Payload.extend({ task: taskPayloadV5Schema.optional() });
const VERSION = 5;
const version = z.literal(VERSION);

/** Version 5 binds nested workflow agent requests to their outer instrumented action. */
export const sessionInboxWireV5Schema = z.discriminatedUnion("kind", [
  v4Deliver.extend({
    payload: deliverPayloadV5Schema,
    payloads: z.array(deliverPayloadV5Schema),
    version,
  }),
  v4[1].extend({ version }),
  v4[2].extend({ version }),
  v4[3].extend({ version }),
  v4[4].extend({ version }),
  v4[5].extend({ version }),
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
