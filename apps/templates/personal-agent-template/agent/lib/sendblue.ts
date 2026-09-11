import { createSendblueAdapter, type SendblueAdapter } from "chat-adapter-sendblue";
import type { SendblueMessagePayload } from "chat-adapter-sendblue";

const DEFAULT_ALLOWED_SERVICES = ["iMessage"] as const;
const WEBHOOK_SECRET_HEADER = "sb-signing-secret";

let adapter: SendblueAdapter | null = null;

export function isSendblueConfigured() {
  return Boolean(
    process.env.SENDBLUE_API_KEY?.trim() &&
    process.env.SENDBLUE_API_SECRET?.trim() &&
    process.env.SENDBLUE_FROM_NUMBER?.trim(),
  );
}

export function getSendblueAdapter() {
  if (!adapter) {
    if (!isSendblueConfigured()) {
      throw new Error(
        "Sendblue is not configured. Set SENDBLUE_API_KEY, SENDBLUE_API_SECRET, and SENDBLUE_FROM_NUMBER.",
      );
    }

    adapter = createSendblueAdapter();
  }

  return adapter;
}

export function verifySendblueWebhook(request: Request) {
  const secret = process.env.SENDBLUE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return true;
  }

  const headerValue = request.headers.get(WEBHOOK_SECRET_HEADER);
  return headerValue === secret;
}

export function isSendblueServiceAllowed(service: string) {
  const allowed = process.env.SENDBLUE_ALLOWED_SERVICES?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [...DEFAULT_ALLOWED_SERVICES];

  return allowed.some((entry) => entry.toLowerCase() === service.toLowerCase());
}

export function isInboundSendblueMessage(body: unknown): body is SendblueMessagePayload {
  if (!body || typeof body !== "object") {
    return false;
  }

  return "message_handle" in body && typeof body.message_handle === "string";
}

export function resolveSendblueLineNumber(payload: SendblueMessagePayload) {
  const fromPayload =
    payload.sendblue_number?.trim() ||
    (payload.is_outbound ? payload.from_number : payload.to_number)?.trim();

  if (fromPayload) {
    return fromPayload;
  }

  return process.env.SENDBLUE_FROM_NUMBER?.trim() ?? "";
}

export function threadIdFromPayload(payload: SendblueMessagePayload, sendblue: SendblueAdapter) {
  const fromNumber = resolveSendblueLineNumber(payload);

  if (payload.group_id?.length) {
    return sendblue.encodeThreadId({ fromNumber, groupId: payload.group_id });
  }

  const contactNumber = payload.is_outbound ? payload.to_number : payload.from_number;
  return sendblue.encodeThreadId({ fromNumber, contactNumber });
}

export function contactNumberFromPayload(payload: SendblueMessagePayload) {
  return payload.is_outbound ? payload.to_number : payload.from_number;
}

export function profileSettingsUrl() {
  const origin = process.env.BETTER_AUTH_URL?.trim().replace(/\/$/, "");
  if (origin) {
    return `${origin}/settings/profile`;
  }

  return "Settings → Profile in the web app";
}
