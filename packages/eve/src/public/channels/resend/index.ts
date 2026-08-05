import type { Adapter, SerializedThread } from "#compiled/chat/index.js";

interface ResendRawReplyContext {
  messageId: string;
  subject: string;
  headers?: Record<string, string>;
}

interface ResendThreadResolver {
  trackMessage(threadId: string, messageId: string): void;
  trackSubject(threadId: string, subject: string): void;
}

interface ResendAdapterWithResolver extends Adapter {
  threadResolver?: ResendThreadResolver;
}

function rawReplyContext(value: unknown): ResendRawReplyContext | undefined {
  const raw = value;
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.messageId !== "string" || typeof record.subject !== "string") {
    return undefined;
  }
  const headers =
    typeof record.headers === "object" && record.headers !== null
      ? Object.fromEntries(
          Object.entries(record.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
  const context: ResendRawReplyContext = {
    messageId: record.messageId,
    subject: record.subject,
  };
  if (headers !== undefined) context.headers = headers;
  return context;
}

function referenceMessageIds(headers: Record<string, string> | undefined): string[] {
  const references = headers?.References ?? headers?.references;
  if (!references) return [];
  const trimmed = references.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      // Malformed provider headers fall back to RFC whitespace parsing below.
    }
  }
  return trimmed.split(/\s+/u).filter(Boolean);
}

/** Captures the inbound Resend raw message into eve's durable channel state. */
export function captureResendReplyContext(input: {
  readonly adapter: Adapter;
  readonly thread: SerializedThread;
}): ResendRawReplyContext | undefined {
  if (input.adapter.name !== "resend") return undefined;
  return rawReplyContext(input.thread.currentMessage?.raw);
}

/**
 * Restores the official Resend adapter's reply metadata from eve's durable
 * channel state. This experimental bridge keeps workflow replies in the inbound
 * email thread until the adapter exposes a public restoration API.
 */
export function restoreResendReplyContext(input: {
  readonly adapter: Adapter;
  readonly context: unknown;
  readonly thread: SerializedThread;
}): void {
  if (input.adapter.name !== "resend") return;
  const context = rawReplyContext(input.context);
  if (context === undefined) return;
  const resolver = (input.adapter as ResendAdapterWithResolver).threadResolver;
  if (
    resolver === undefined ||
    typeof resolver.trackMessage !== "function" ||
    typeof resolver.trackSubject !== "function"
  ) {
    return;
  }
  resolver.trackSubject(input.thread.id, context.subject);
  for (const messageId of referenceMessageIds(context.headers)) {
    resolver.trackMessage(input.thread.id, messageId);
  }
  resolver.trackMessage(input.thread.id, context.messageId);
}
