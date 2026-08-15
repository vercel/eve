import {
  parseTwilioWebhookBody,
  type TwilioMediaPayload,
} from "#compiled/@chat-adapter/twilio/webhook.js";
import {
  parseTwilioVoiceCall as parsePrimitiveVoiceCall,
  parseTwilioVoiceTranscription as parsePrimitiveVoiceTranscription,
} from "#compiled/@chat-adapter/twilio/voice.js";

/** Channel-owned representation of one inbound Twilio text or media message. */
export interface TwilioTextMessage {
  readonly from: string;
  readonly to: string | undefined;
  readonly body: string;
  readonly messageSid: string | undefined;
  readonly accountSid: string | undefined;
  /** MMS media metadata parsed from Twilio's `MediaUrl*` webhook fields. */
  readonly media?: readonly TwilioMediaPayload[];
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

/** Inbound identity fields for the model-visible `<twilio_context>` block. */
export interface TwilioInboundContext {
  readonly from: string;
  readonly to?: string;
  readonly messageSid?: string;
  readonly callSid?: string;
  readonly channel: "text" | "voice";
}

/** Parses Twilio's incoming-message webhook fields into Eve's text payload. */
export function parseTwilioTextMessage(params: URLSearchParams): TwilioTextMessage | null {
  const payload = parseTwilioWebhookBody(params);
  if (payload.kind !== "text") {
    return null;
  }

  return {
    accountSid: payload.accountSid,
    body: payload.body,
    from: payload.from,
    media: payload.media,
    messageSid: payload.messageSid,
    raw: payload.raw,
    to: payload.to,
  };
}

/** Parses Twilio's incoming-call webhook fields into Eve's voice payload. */
export function parseTwilioVoiceCall(params: URLSearchParams): TwilioVoiceCall | null {
  const call = parsePrimitiveVoiceCall(params);
  if (!call) {
    return null;
  }

  return {
    accountSid: call.accountSid,
    callSid: call.callSid,
    from: call.from,
    raw: call.raw,
    to: call.to,
  };
}

/**
 * Parses Twilio speech callbacks.
 *
 * Supports `<Gather input="speech">`, recording transcription callbacks, and
 * real-time transcription callbacks. Real-time partial results are ignored.
 */
export function parseTwilioVoiceTranscription(
  params: URLSearchParams,
): TwilioVoiceTranscription | null {
  const transcription = parsePrimitiveVoiceTranscription(params);
  if (!transcription?.from) {
    return null;
  }

  return {
    callSid: transcription.callSid,
    confidence: transcription.confidence,
    from: transcription.from,
    raw: transcription.raw,
    text: transcription.text,
    to: transcription.to,
    transcriptionSid: transcription.transcriptionSid,
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
