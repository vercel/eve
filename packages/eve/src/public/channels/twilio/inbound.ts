/**
 * Twilio inbound webhook parsing and prompt shaping.
 *
 * The channel owns these small data shapes instead of exposing raw
 * Twilio webhook payloads as the public API surface.
 */

/** Channel-owned representation of one inbound Twilio text message. */
export interface TwilioTextMessage {
  readonly from: string;
  readonly to: string | undefined;
  readonly body: string;
  readonly messageSid: string | undefined;
  readonly accountSid: string | undefined;
  readonly raw: URLSearchParams;
}

/** Channel-owned representation of one inbound Twilio voice call. */
export interface TwilioVoiceCall {
  readonly from: string;
  readonly to: string | undefined;
  readonly callSid: string | undefined;
  readonly accountSid: string | undefined;
  readonly raw: URLSearchParams;
}

/** Channel-owned representation of one inbound Twilio voice transcription. */
export interface TwilioVoiceTranscription {
  readonly from: string;
  readonly to: string | undefined;
  readonly callSid: string | undefined;
  readonly text: string;
  readonly confidence: number | undefined;
  readonly transcriptionSid: string | undefined;
  readonly raw: URLSearchParams;
}

const TWILIO_SMS_RESPONSE_INSTRUCTIONS =
  "Reply for SMS in plain text. Keep the response concise and avoid Markdown formatting, " +
  "tables, headings, code fences, and long lists. Ask at most one short follow-up question " +
  "when more information is needed.";

/**
 * Inbound identity fields for the model-visible `<twilio_context>` block.
 * Stores the caller and receiver numbers, the originating SID, and the turn
 * medium (text or voice).
 */
export interface TwilioInboundContext {
  readonly from: string;
  readonly to?: string;
  readonly messageSid?: string;
  readonly callSid?: string;
  readonly channel: "text" | "voice";
}

/** Parses Twilio's incoming-message webhook fields. */
export function parseTwilioTextMessage(params: URLSearchParams): TwilioTextMessage | null {
  const from = requiredParam(params, "From");
  const body = requiredParam(params, "Body");
  if (!from || !body) return null;

  return {
    accountSid: optionalParam(params, "AccountSid"),
    body,
    from,
    messageSid: optionalParam(params, "MessageSid") ?? optionalParam(params, "SmsMessageSid"),
    raw: params,
    to: optionalParam(params, "To"),
  };
}

/** Parses Twilio's incoming-call webhook fields. */
export function parseTwilioVoiceCall(params: URLSearchParams): TwilioVoiceCall | null {
  const from = requiredParam(params, "From") ?? requiredParam(params, "Caller");
  if (!from) return null;

  return {
    accountSid: optionalParam(params, "AccountSid"),
    callSid: optionalParam(params, "CallSid"),
    from,
    raw: params,
    to: optionalParam(params, "To") ?? optionalParam(params, "Called"),
  };
}

/**
 * Parses Twilio voice transcription fields.
 *
 * Supports `<Gather input="speech">` (`SpeechResult`), recording
 * transcription callbacks (`TranscriptionText`), and real-time
 * transcription callbacks (`TranscriptionData` JSON). Real-time partial
 * results are ignored until Twilio marks them final.
 */
export function parseTwilioVoiceTranscription(
  params: URLSearchParams,
): TwilioVoiceTranscription | null {
  const from = requiredParam(params, "From") ?? requiredParam(params, "Caller");
  if (!from) return null;

  const parsedData = parseTranscriptionData(optionalParam(params, "TranscriptionData"));
  const final = optionalParam(params, "Final");
  if (final === "false") return null;

  const text =
    optionalParam(params, "SpeechResult") ??
    optionalParam(params, "TranscriptionText") ??
    parsedData?.transcript ??
    "";
  if (!text.trim()) return null;

  return {
    callSid: optionalParam(params, "CallSid"),
    confidence: parseConfidence(optionalParam(params, "Confidence") ?? parsedData?.confidence),
    from,
    raw: params,
    text,
    to: optionalParam(params, "To") ?? optionalParam(params, "Called"),
    transcriptionSid: optionalParam(params, "TranscriptionSid"),
  };
}

/** Renders a deterministic `<twilio_context>` block for the model. */
export function formatTwilioContextBlock(context: TwilioInboundContext): string {
  const lines = [
    "<twilio_context>",
    `channel: ${context.channel}`,
    "response_medium: sms",
    `response_instructions: ${TWILIO_SMS_RESPONSE_INSTRUCTIONS}`,
    `from: ${context.from}`,
    ...(context.to ? [`to: ${context.to}`] : []),
    ...(context.messageSid ? [`message_sid: ${context.messageSid}`] : []),
    ...(context.callSid ? [`call_sid: ${context.callSid}`] : []),
    "</twilio_context>",
  ];
  return lines.join("\n");
}

function requiredParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  return value && value.trim().length > 0 ? value : null;
}

function optionalParam(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name);
  return value === null || value.length === 0 ? undefined : value;
}

function parseTranscriptionData(
  value: string | undefined,
): { transcript?: string; confidence?: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { transcript?: unknown; confidence?: unknown };
    return {
      confidence:
        typeof parsed.confidence === "number" || typeof parsed.confidence === "string"
          ? String(parsed.confidence)
          : undefined,
      transcript: typeof parsed.transcript === "string" ? parsed.transcript : undefined,
    };
  } catch {
    return null;
  }
}

function parseConfidence(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
