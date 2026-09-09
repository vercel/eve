import { z } from "#compiled/zod/index.js";

import type {
  DeliverHookPayload,
  DeliverPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
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
  history: z.array(z.unknown()).optional(),
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

/** Version 7 allows workflow-owned subagent invocations to preload history. */
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
  const histories = readInvocationHistories(command);
  const value = restoreInvocationHistories(
    { ...encodeSessionCommandV6(withoutInvocationHistories(command)), version: VERSION },
    histories,
  );
  const parsed = sessionInboxWireV7Schema.safeParse(value);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version ${VERSION}: ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function readInvocationHistories(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): ReadonlyMap<string, unknown> {
  const histories = new Map<string, unknown>();
  if (command.kind !== "send" && command.kind !== "deliver") return histories;
  const payloads = command.kind === "send" ? [command.payload] : command.payloads;
  for (const payload of payloads) {
    for (const delivery of payload.task?.agentRequests ?? []) {
      if (
        delivery.request.kind === "agent-invoke" &&
        delivery.request.input.history !== undefined
      ) {
        histories.set(delivery.request.invocationId, delivery.request.input.history);
      }
    }
  }
  return histories;
}

function withoutInvocationHistories(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload {
  if (command.kind !== "send" && command.kind !== "deliver") return command;
  const stripPayload = (payload: DeliverPayload): DeliverPayload => ({
    ...payload,
    task:
      payload.task === undefined
        ? undefined
        : {
            ...payload.task,
            agentRequests: payload.task.agentRequests?.map((delivery) => {
              if (delivery.request.kind !== "agent-invoke") return delivery;
              const { history: _history, ...input } = delivery.request.input;
              return { ...delivery, request: { ...delivery.request, input } };
            }),
          },
  });
  return command.kind === "send"
    ? { ...command, payload: stripPayload(command.payload) }
    : { ...command, payloads: command.payloads.map(stripPayload) };
}

function restoreInvocationHistories(
  value: unknown,
  histories: ReadonlyMap<string, unknown>,
): unknown {
  if (histories.size === 0 || value === null || typeof value !== "object") return value;
  const wire = value as Record<string, unknown>;
  const restorePayload = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate !== "object") return candidate;
    const payload = candidate as Record<string, unknown>;
    const task = payload.task;
    if (task === null || typeof task !== "object") return payload;
    const agentRequests = (task as Record<string, unknown>).agentRequests;
    if (!Array.isArray(agentRequests)) return payload;
    return {
      ...payload,
      task: {
        ...(task as Record<string, unknown>),
        agentRequests: agentRequests.map((candidate) => {
          if (candidate === null || typeof candidate !== "object") return candidate;
          const delivery = candidate as Record<string, unknown>;
          const request = delivery.request;
          if (request === null || typeof request !== "object") return delivery;
          const requestRecord = request as Record<string, unknown>;
          const history = histories.get(String(requestRecord.invocationId));
          if (
            history === undefined ||
            requestRecord.input === null ||
            typeof requestRecord.input !== "object"
          ) {
            return delivery;
          }
          return {
            ...delivery,
            request: {
              ...requestRecord,
              input: { ...(requestRecord.input as Record<string, unknown>), history },
            },
          };
        }),
      },
    };
  };
  return {
    ...wire,
    payload: restorePayload(wire.payload),
    payloads: Array.isArray(wire.payloads) ? wire.payloads.map(restorePayload) : wire.payloads,
  };
}
