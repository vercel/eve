import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";

export type DecodedSessionInbox =
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
  switch (payload.kind) {
    case "send": {
      if (payload.payload === null || typeof payload.payload !== "object") {
        throw new SessionInboxPayloadError("Session send payload must be an object.");
      }
      const command = value as Extract<SessionCommand, { readonly kind: "send" }>;
      return {
        auth: command.auth,
        caller: command.caller,
        deliveryMetadata:
          command.delivery === undefined ? undefined : [{ ...command.delivery, payloadIndex: 0 }],
        kind: "deliver",
        payloads: [command.payload],
        requestId: command.requestId,
        taskDeliveryId: command.taskDeliveryId,
        turnPolicy: command.turnPolicy,
      };
    }
    case "deliver": {
      if (!Array.isArray(payload.payloads)) {
        throw new SessionInboxPayloadError("Session delivery payloads must be an array.");
      }
      return value as DeliverHookPayload;
    }
    case "cancel":
    case "clear":
    case "compact":
    case "reset":
    case "session-timeout":
      return value as DecodedSessionInbox;
    default:
      throw new SessionInboxPayloadError(
        `Unsupported session inbox payload kind ${JSON.stringify(payload.kind)}.`,
      );
  }
}
