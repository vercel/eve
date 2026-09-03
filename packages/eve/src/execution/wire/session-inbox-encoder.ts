import type {
  DeliverHookPayload,
  DeliverPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import {
  encodeSessionCommandV1,
  type SessionInboxWireV1,
} from "#execution/wire/session-inbox-wire.v1.js";
import {
  encodeSessionCommandV2,
  type SessionInboxWireV2,
} from "#execution/wire/session-inbox-wire.v2.js";
import {
  encodeSessionCommandV3,
  type SessionInboxWireV3,
} from "#execution/wire/session-inbox-wire.v3.js";
import {
  isSessionInboxWireVersion,
  SessionInboxWireError,
  type SessionInboxWireTarget,
  type SessionInboxWireVersion,
} from "#execution/wire/session-inbox-contract.js";
import { encodeSessionCommandV0 } from "#execution/wire/session-inbox-wire.v0.js";
import {
  encodeSessionCommandV4,
  type SessionInboxWireV4,
} from "#execution/wire/session-inbox-wire.v4.js";
import {
  encodeSessionCommandV5,
  type SessionInboxWireV5,
} from "#execution/wire/session-inbox-wire.v5.js";

type SessionInboxCommand = DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload;

/** Current wire type consumed after migration. */
export type SessionInboxWire = SessionInboxWireV5;

type LegacySessionInboxWireTarget = Extract<SessionInboxWireTarget, { readonly version: 0 }>;
type VersionedSessionInboxEncoder = (command: SessionInboxCommand) => unknown;

const versionedEncoders = {
  1: (command: SessionInboxCommand) => encodeSessionCommandV1(withoutAcceptedDeployment(command)),
  2: (command: SessionInboxCommand) => encodeSessionCommandV2(withoutAcceptedDeployment(command)),
  3: encodeSessionCommandV3,
  4: (command: SessionInboxCommand) =>
    encodeSessionCommandV4(withoutWorkflowActionIdentity(command)),
  5: encodeSessionCommandV5,
} satisfies Record<SessionInboxWireVersion, VersionedSessionInboxEncoder>;

/** Encodes a command for the selected session-inbox consumer. */
function encode(command: SessionInboxCommand, target: { readonly version: 1 }): SessionInboxWireV1;
function encode(command: SessionInboxCommand, target: { readonly version: 2 }): SessionInboxWireV2;
function encode(command: SessionInboxCommand, target: { readonly version: 3 }): SessionInboxWireV3;
function encode(command: SessionInboxCommand, target: { readonly version: 4 }): SessionInboxWireV4;
function encode(command: SessionInboxCommand, target: { readonly version: 5 }): SessionInboxWireV5;
function encode(
  command: SessionInboxCommand,
  target: { readonly version: SessionInboxWireVersion },
): unknown;
function encode(
  command: SessionInboxCommand,
  target: LegacySessionInboxWireTarget,
): Record<string, unknown>;
function encode(
  command: SessionInboxCommand,
  target: SessionInboxWireTarget,
):
  | SessionInboxWireV1
  | SessionInboxWireV2
  | SessionInboxWireV3
  | SessionInboxWireV4
  | SessionInboxWireV5
  | Record<string, unknown>;
function encode(
  command: SessionInboxCommand,
  target: SessionInboxWireTarget,
):
  | SessionInboxWireV1
  | SessionInboxWireV2
  | SessionInboxWireV3
  | SessionInboxWireV4
  | SessionInboxWireV5
  | Record<string, unknown> {
  if (target.version === 0) {
    const currentTaskWire =
      target.variant === "send" && command.kind === "send" && command.payload.task !== undefined
        ? encodeSessionCommandV5(command)
        : undefined;
    let legacy = encodeSessionCommandV0(
      encodeSessionCommandV1(withoutCurrentTaskMessages(withoutAcceptedDeployment(command))),
      target.variant,
    );
    if (currentTaskWire?.kind === "deliver") {
      legacy = { ...legacy, payload: currentTaskWire.payload };
    }
    const legacyRecord = legacy as Record<string, unknown>;
    const delivery = legacyRecord.delivery;
    const acceptedDeploymentId = readAcceptedDeploymentId(command);
    if (
      target.variant !== "send" ||
      acceptedDeploymentId === undefined ||
      legacyRecord.kind !== "send" ||
      typeof delivery !== "object" ||
      delivery === null
    ) {
      return legacy;
    }
    return {
      ...legacy,
      delivery: { ...(delivery as Record<string, unknown>), acceptedDeploymentId },
    };
  }
  if (isSessionInboxWireVersion(target.version)) {
    return versionedEncoders[target.version](command) as
      | SessionInboxWireV1
      | SessionInboxWireV2
      | SessionInboxWireV3
      | SessionInboxWireV4
      | SessionInboxWireV5;
  }
  throw new SessionInboxWireError(
    `Cannot encode session inbox payload for unknown wire version ${JSON.stringify((target as { version?: unknown }).version)}.`,
  );
}

function withoutCurrentTaskMessages(command: SessionInboxCommand): SessionInboxCommand {
  if (command.kind !== "send" || command.payload.task === undefined) return command;
  const {
    agentRequests: _agentRequests,
    inputRequests: _inputRequests,
    ...task
  } = command.payload.task;
  return { ...command, payload: { ...command.payload, task } };
}

function withoutWorkflowActionIdentity(command: SessionInboxCommand): SessionInboxCommand {
  if (command.kind === "send") {
    return { ...command, payload: stripWorkflowActionIdentity(command.payload) };
  }
  if (command.kind === "deliver") {
    return { ...command, payloads: command.payloads.map(stripWorkflowActionIdentity) };
  }
  return command;
}

function stripWorkflowActionIdentity(payload: DeliverPayload): DeliverPayload {
  const requests = payload.task?.agentRequests;
  if (requests === undefined) return payload;
  return {
    ...payload,
    task: {
      ...payload.task,
      agentRequests: requests.map((delivery) => {
        const { actionCallId: _actionCallId, ...legacyDelivery } = delivery;
        if (delivery.request.kind !== "agent-invoke") return legacyDelivery;
        const { instrumentationCallId: _instrumentationCallId, ...legacyRequest } =
          delivery.request;
        return { ...legacyDelivery, request: legacyRequest };
      }),
    },
  };
}

function withoutAcceptedDeployment(command: SessionInboxCommand): SessionInboxCommand {
  if (command.kind === "send" && command.delivery?.acceptedDeploymentId !== undefined) {
    const { acceptedDeploymentId: _acceptedDeploymentId, ...delivery } = command.delivery;
    return { ...command, delivery };
  }
  if (command.kind !== "deliver" || command.deliveryMetadata === undefined) return command;
  return {
    ...command,
    deliveryMetadata: command.deliveryMetadata.map((metadata) => {
      const { acceptedDeploymentId: _acceptedDeploymentId, ...legacy } = metadata;
      return legacy;
    }),
  };
}

function readAcceptedDeploymentId(command: SessionInboxCommand): string | undefined {
  if (command.kind === "send") return command.delivery?.acceptedDeploymentId;
  if (command.kind !== "deliver") return undefined;
  return command.deliveryMetadata?.find((metadata) => metadata.payloadIndex === 0)
    ?.acceptedDeploymentId;
}
/** Server/step-safe producer facade. */
export const sessionInboxWire = { encode } as const;
