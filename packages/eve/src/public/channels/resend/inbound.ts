import { convertHtmlToMarkdown } from "#execution/web-fetch/html.js";
import type { ResendReceivedEmailPayload } from "#public/channels/resend/api.js";
import { isObject } from "#shared/guards.js";

/** One verdict from the receiving mail server. The sender cannot forge these. */
export type ResendAuthenticationResult = "pass" | "fail" | "gray" | "processing_failed" | "unknown";

/** SPF, DKIM, and DMARC results Resend computed when the email arrived. */
export interface ResendEmailAuthentication {
  readonly spf?: ResendAuthenticationResult;
  readonly dkim?: ResendAuthenticationResult;
  readonly dmarc?: ResendAuthenticationResult;
}

/** The `email.received` webhook fields the channel reads before fetching the email. */
export interface ResendReceivedEvent {
  readonly emailId: string;
  /** Bare, lowercased sender address. */
  readonly address: string;
}

/** Attachment metadata on a received email. */
export interface ResendEmailAttachment {
  readonly id: string | undefined;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number | undefined;
}

/** Channel-owned representation of one received email. */
export interface ResendEmail {
  /** Resend email ID. */
  readonly id: string;
  /** RFC 5322 `Message-ID`, such as `<abc@mail.example.com>`. */
  readonly messageId: string;
  /** `From` as sent, such as `Alice <alice@example.com>`. */
  readonly from: string;
  /** Bare, lowercased sender address. */
  readonly address: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  /** Body as text: the text part, or the HTML part converted to Markdown. */
  readonly body: string;
  /** Earlier `Message-ID`s in the thread, oldest first, from `References` and `In-Reply-To`. */
  readonly references: readonly string[];
  readonly attachments: readonly ResendEmailAttachment[];
  /** `null` when Resend did not report results for this email. */
  readonly authentication: ResendEmailAuthentication | null;
}

/** Parses an `email.received` webhook. Returns `null` for any other event. */
export function parseResendReceivedEvent(body: string): ResendReceivedEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(payload) || payload.type !== "email.received" || !isObject(payload.data)) {
    return null;
  }
  const { email_id: emailId, from } = payload.data;
  if (typeof emailId !== "string" || typeof from !== "string") return null;
  const address = parseEmailAddress(from);
  return address === null ? null : { address, emailId };
}

/** Builds a {@link ResendEmail} from Resend's received-email response. */
export function toResendEmail(payload: ResendReceivedEmailPayload): ResendEmail | null {
  const { id, message_id: messageId, from } = payload;
  if (typeof id !== "string" || typeof messageId !== "string" || typeof from !== "string") {
    return null;
  }
  const address = parseEmailAddress(from);
  if (address === null) return null;
  const headers = isObject(payload.headers) ? payload.headers : {};
  const references = threadReferences(headers, messageId);
  return {
    address,
    attachments: parseAttachments(payload.attachments),
    authentication: payload.authentication ?? null,
    body: emailBody(payload, references.length > 0),
    cc: stringArray(payload.cc),
    from,
    id,
    messageId,
    references,
    subject: typeof payload.subject === "string" ? payload.subject : "",
    to: stringArray(payload.to),
  };
}

/** The `Message-ID` that started the email's thread. */
export function resendThreadRoot(email: Pick<ResendEmail, "messageId" | "references">): string {
  return email.references[0] ?? email.messageId;
}

/**
 * Continuation token for one sender's email thread. Keying on the sender keeps someone who
 * learns another thread's `Message-ID` from joining that thread's session.
 */
export function resendContinuationToken(input: {
  readonly address: string;
  readonly rootMessageId: string;
}): string {
  return `${input.address}:${input.rootMessageId}`;
}

/** Extracts the bare, lowercased address from `Name <addr>` or `addr`. */
export function parseEmailAddress(value: string): string | null {
  const address = (/<([^<>\s]+@[^<>\s]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+$/.test(address) ? address : null;
}

/** `Re: ` plus the subject, unless it already starts with a reply prefix. */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed.length === 0) return "Re: your email";
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

const RESEND_EMAIL_RESPONSE_INSTRUCTIONS =
  "Write the reply as a plain-text email body. Do not add a subject line, a greeting " +
  "placeholder, or a signature placeholder.";

/** Renders a deterministic `<resend_context>` block for the model. */
export function formatResendContextBlock(email: ResendEmail): string {
  const lines = [
    "<resend_context>",
    "response_medium: email",
    `response_instructions: ${RESEND_EMAIL_RESPONSE_INSTRUCTIONS}`,
    `from: ${email.from}`,
    ...(email.to.length > 0 ? [`to: ${email.to.join(", ")}`] : []),
    ...(email.cc.length > 0 ? [`cc: ${email.cc.join(", ")}`] : []),
    `subject: ${email.subject}`,
    ...email.attachments.map((file) => `attachment: ${file.filename} (${file.contentType})`),
    "</resend_context>",
  ];
  return lines.join("\n");
}

function threadReferences(headers: Record<string, unknown>, messageId: string): string[] {
  const ids = [
    ...messageIds(headerValue(headers, "references")),
    ...messageIds(headerValue(headers, "in-reply-to")),
  ];
  return [...new Set(ids)].filter((id) => id !== messageId);
}

function headerValue(headers: Record<string, unknown>, name: string): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return "";
}

function messageIds(value: string): string[] {
  return value.match(/<[^<>\s]+>/g) ?? [];
}

/** Longest body the model receives. Longer bodies are cut, with a note. */
const MAX_BODY_CHARS = 50_000;

function emailBody(payload: ResendReceivedEmailPayload, isReply: boolean): string {
  const text =
    typeof payload.text === "string" && payload.text.trim().length > 0
      ? payload.text
      : typeof payload.html === "string"
        ? convertHtmlToMarkdown(payload.html.slice(0, MAX_BODY_CHARS * 4))
        : "";
  const body = (isReply ? stripQuotedReply(text) : text).trim();
  return body.length > MAX_BODY_CHARS
    ? `${body.slice(0, MAX_BODY_CHARS)}\n\n[Email truncated after ${MAX_BODY_CHARS} characters.]`
    : body;
}

/**
 * Drops the quoted earlier message a reply carries below it. The session already holds the
 * earlier turns, so the quote only costs tokens.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);
  let end = lines.length;
  while (end > 0 && (lines[end - 1]!.trim() === "" || lines[end - 1]!.startsWith(">"))) end -= 1;
  if (end === lines.length || !lines.slice(end).some((line) => line.startsWith(">"))) return text;
  if (end > 0 && /^on\b.*wrote:\s*$/i.test(lines[end - 1]!.trim())) end -= 1;
  return lines.slice(0, end).join("\n");
}

function parseAttachments(value: unknown): ResendEmailAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((item) => ({
    contentType:
      typeof item.content_type === "string" ? item.content_type : "application/octet-stream",
    filename: typeof item.filename === "string" ? item.filename : "attachment",
    id: typeof item.id === "string" ? item.id : undefined,
    size: typeof item.size === "number" ? item.size : undefined,
  }));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
