import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { withoutPreV27Answers } from "#execution/session-inbox/pre-v27.js";
import { validateDeliveryIdempotencyKey } from "#channel/delivery-idempotency.js";

import type { SessionPrewarmPayload } from "#execution/session-prewarm.js";

type DecodedSessionInbox =
  | SessionPrewarmPayload
  | DeliverHookPayload
  | SessionTimeoutHookPayload
  | Extract<SessionCommand, { readonly kind: "cancel" | "clear" | "compact" | "reset" }>;

/** Invalid current-generation inbox payload. Historical wire shapes are not accepted. */
export class SessionInboxPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionInboxPayloadError";
  }
}

/** Normalizes the one authored `send` convenience command into a delivery. */
export function decodeSessionInboxPayload(value: unknown): DecodedSessionInbox {
  if (value === null || typeof value !== "object" || !("kind" in value)) {
    throw new SessionInboxPayloadError("Session inbox payload must be an object with a kind.");
  }
  const payload = value as Record<string, unknown>;
  if (payload.kind === "send" || payload.kind === "deliver") {
    try {
      validateDeliveryIdempotencyKey(payload.idempotencyKey);
    } catch (error) {
      throw new SessionInboxPayloadError((error as Error).message);
    }
  }
  switch (payload.kind) {
    case "send": {
      if (payload.payload === null || typeof payload.payload !== "object") {
        throw new SessionInboxPayloadError("Session send payload must be an object.");
      }
      const command = value as Extract<SessionCommand, { readonly kind: "send" }>;
      return {
        idempotencyKey: command.idempotencyKey,
        auth: command.auth,
        schedule: command.schedule,
        title: command.title,
        caller: command.caller,
        deliveryMetadata:
          command.delivery === undefined ? undefined : [{ ...command.delivery, payloadIndex: 0 }],
        kind: "deliver",
        payloads: [withoutPreV27Answers(command.payload)],
        requestId: command.requestId,
        turnPolicy: command.turnPolicy,
      };
    }
    case "deliver": {
      if (!Array.isArray(payload.payloads)) {
        throw new SessionInboxPayloadError("Session delivery payloads must be an array.");
      }
      const delivery = value as DeliverHookPayload;
      return { ...delivery, payloads: delivery.payloads.map(withoutPreV27Answers) };
    }
    case "session-prewarm":
      if (
        typeof payload.expectedOwnerRunId !== "string" ||
        typeof payload.targetDeploymentId !== "string" ||
        payload.targetDeploymentId.length === 0 ||
        payload.targetDeploymentId === "latest"
      )
        throw new SessionInboxPayloadError("Invalid session prewarm hint.");
      return value as SessionPrewarmPayload;
    case "cancel":
    case "clear":
    case "compact":
    case "reset":
      if (typeof payload.deliveryId !== "string" || payload.deliveryId.length === 0) {
        throw new SessionInboxPayloadError("Session controls require a nonempty deliveryId.");
      }
      return value as DecodedSessionInbox;
    case "session-timeout":
      return value as DecodedSessionInbox;
    default:
      throw new SessionInboxPayloadError(
        `Unsupported session inbox payload kind ${JSON.stringify(payload.kind)}.`,
      );
  }
}
