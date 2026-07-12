/**
 * AgentPhone inbound webhook parsing and prompt shaping.
 *
 * The channel owns these small data shapes instead of exposing raw
 * AgentPhone webhook payloads as the public API surface.
 */

/** Channel-owned representation of an inbound AgentPhone text message. */
export interface AgentPhoneTextMessage {
  readonly from: string;
  readonly to: string | undefined;
  readonly body: string;
  readonly channel: "sms" | "mms" | "imessage";
  readonly conversationId: string | undefined;
  readonly numberId: string | undefined;
  readonly agentId: string | undefined;
  readonly mediaUrl: string | undefined;
  readonly raw: Record<string, unknown>;
}

/** Channel-owned representation of an inbound AgentPhone voice webhook. */
export interface AgentPhoneVoiceMessage {
  readonly from: string;
  readonly to: string | undefined;
  readonly transcript: string;
  readonly callId: string | undefined;
  readonly numberId: string | undefined;
  readonly agentId: string | undefined;
  readonly confidence: number | undefined;
  readonly raw: Record<string, unknown>;
}

/** Channel-owned representation of an AgentPhone call-ended event. */
export interface AgentPhoneCallEnded {
  readonly from: string;
  readonly to: string | undefined;
  readonly callId: string | undefined;
  readonly numberId: string | undefined;
  readonly agentId: string | undefined;
  readonly durationSeconds: number | undefined;
  readonly summary: string | undefined;
  readonly transcript: readonly { role: string; content: string }[] | undefined;
  readonly raw: Record<string, unknown>;
}

/** Channel-owned representation of an AgentPhone iMessage reaction. */
export interface AgentPhoneReaction {
  readonly fromNumber: string;
  readonly conversationId: string | undefined;
  readonly reactionType: string;
  readonly messageId: string | undefined;
  readonly messageBody: string | undefined;
  readonly raw: Record<string, unknown>;
}

const AGENTPHONE_SMS_RESPONSE_INSTRUCTIONS =
  "Reply for SMS in plain text. Keep the response concise and avoid Markdown formatting, " +
  "tables, headings, code fences, and long lists. Ask at most one short follow-up question " +
  "when more information is needed.";

/** Inbound identity fields for the model-visible `<agentphone_context>` block. */
export interface AgentPhoneInboundContext {
  readonly from: string;
  readonly to?: string;
  readonly conversationId?: string;
  readonly callId?: string;
  readonly channel: "sms" | "mms" | "imessage" | "voice";
}

/** Parses an `agent.message` webhook with a text channel. */
export function parseAgentPhoneTextMessage(
  payload: Record<string, unknown>,
): AgentPhoneTextMessage | null {
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return null;

  const from = readString(data.from);
  const body = readString(data.message);
  if (!from || !body) return null;

  return {
    agentId: readString(payload.agentId),
    body,
    channel: (readString(payload.channel) as "sms" | "mms" | "imessage") ?? "sms",
    conversationId: readString(data.conversationId),
    from,
    mediaUrl: readString(data.mediaUrl),
    numberId: readString(data.numberId),
    raw: payload,
    to: readString(data.to),
  };
}

/** Parses an `agent.message` webhook with a voice channel. */
export function parseAgentPhoneVoiceMessage(
  payload: Record<string, unknown>,
): AgentPhoneVoiceMessage | null {
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return null;

  const from = readString(data.from);
  const transcript = readString(data.transcript);
  if (!from || !transcript) return null;

  return {
    agentId: readString(payload.agentId),
    callId: readString(data.callId),
    confidence: typeof data.confidence === "number" ? data.confidence : undefined,
    from,
    numberId: readString(data.numberId),
    raw: payload,
    to: readString(data.to),
    transcript,
  };
}

/** Parses an `agent.call_ended` webhook. */
export function parseAgentPhoneCallEnded(
  payload: Record<string, unknown>,
): AgentPhoneCallEnded | null {
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return null;

  const from = readString(data.from);
  if (!from) return null;

  return {
    agentId: readString(payload.agentId),
    callId: readString(data.callId),
    durationSeconds: typeof data.durationSeconds === "number" ? data.durationSeconds : undefined,
    from,
    numberId: readString(data.numberId),
    raw: payload,
    summary: readString(data.summary),
    to: readString(data.to),
    transcript: Array.isArray(data.transcript)
      ? (data.transcript as { role: string; content: string }[])
      : undefined,
  };
}

/** Parses an `agent.reaction` webhook. */
export function parseAgentPhoneReaction(
  payload: Record<string, unknown>,
): AgentPhoneReaction | null {
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return null;

  const fromNumber = readString(data.fromNumber);
  const reactionType = readString(data.reactionType);
  if (!fromNumber || !reactionType) return null;

  return {
    conversationId: readString(data.conversationId),
    fromNumber,
    messageBody: readString(data.messageBody),
    messageId: readString(data.messageId),
    raw: payload,
    reactionType,
  };
}

/** Renders a deterministic `<agentphone_context>` block for the model. */
export function formatAgentPhoneContextBlock(context: AgentPhoneInboundContext): string {
  const lines = [
    "<agentphone_context>",
    `channel: ${context.channel}`,
    "response_medium: sms",
    `response_instructions: ${AGENTPHONE_SMS_RESPONSE_INSTRUCTIONS}`,
    `from: ${context.from}`,
    ...(context.to ? [`to: ${context.to}`] : []),
    ...(context.conversationId ? [`conversation_id: ${context.conversationId}`] : []),
    ...(context.callId ? [`call_id: ${context.callId}`] : []),
    "</agentphone_context>",
  ];
  return lines.join("\n");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
