import { z } from "#compiled/zod/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import {
  encodeSessionCommandV6,
  sessionInboxWireV6Schema,
} from "#execution/wire/session-inbox-wire.v6.js";
import { formatValidationError } from "#runtime/validation.js";

const VERSION = 7;
const version = z.literal(VERSION);
const v6 = sessionInboxWireV6Schema.options;
const deliverPayloadV6Schema = v6[0].shape.payload;
const taskPayloadV6Schema = deliverPayloadV6Schema.shape.task.unwrap();
const taskAgentRequestV6Schema = taskPayloadV6Schema.shape.agentRequests.unwrap().element;
const agentRequestV6Schemas = taskAgentRequestV6Schema.shape.request.options;
const agentInvocationV6Schema = agentRequestV6Schemas[0];
const agentInvocationInputV7Schema = agentInvocationV6Schema.shape.input.extend({
  parentHistory: z.array(z.unknown()).optional(),
});
const taskAgentRequestV7Schema = taskAgentRequestV6Schema.extend({
  request: z.discriminatedUnion("kind", [
    agentInvocationV6Schema.extend({ input: agentInvocationInputV7Schema }),
    agentRequestV6Schemas[1],
  ]),
});
const taskPayloadV7Schema = taskPayloadV6Schema.extend({
  agentRequests: z.array(taskAgentRequestV7Schema).optional(),
});
const deliverPayloadV7Schema = deliverPayloadV6Schema.extend({
  task: taskPayloadV7Schema.optional(),
});

/** Version 7 allows workflow-owned subagent invocations to carry private parent history. */
export const sessionInboxWireV7Schema = z.discriminatedUnion("kind", [
  v6[0].extend({
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
  const value =
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
        : { ...encodeSessionCommandV6(command), version: VERSION };
  const parsed = sessionInboxWireV7Schema.safeParse(value);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version ${VERSION}: ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}
