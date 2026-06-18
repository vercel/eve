import type { SessionAuthContext } from "#channel/types.js";

import { extractErrorId, formatErrorHint } from "#internal/logging.js";
import type {
  AgentPhoneCallEnded,
  AgentPhoneTextMessage,
  AgentPhoneVoiceMessage,
} from "#public/channels/agentphone/inbound.js";
import type {
  AgentPhoneChannelEvents,
  AgentPhoneContext,
  AgentPhoneInboundResult,
  AgentPhoneVoiceResult,
} from "#public/channels/agentphone/agentphoneChannel.js";

/** Default phone-number auth projection for AgentPhone webhook actors. */
export function defaultAgentPhoneAuth(input: {
  readonly from: string;
  readonly to?: string;
  readonly channel: "sms" | "mms" | "imessage" | "voice";
}): SessionAuthContext {
  const attributes: Record<string, string> = {
    channel: input.channel,
    from: input.from,
  };
  if (input.to !== undefined) attributes.to = input.to;

  return {
    attributes,
    authenticator: "agentphone-webhook",
    issuer: "agentphone",
    principalId: `agentphone:${input.from}`,
    principalType: "user",
  };
}

/** Default inbound text hook: dispatch with AgentPhone phone-number auth. */
export function defaultOnText(
  _ctx: AgentPhoneContext,
  message: AgentPhoneTextMessage,
): AgentPhoneInboundResult {
  return {
    auth: defaultAgentPhoneAuth({
      channel: message.channel,
      from: message.from,
      to: message.to,
    }),
  };
}

/** Default inbound voice hook: accept the webhook with no overrides. */
export function defaultOnVoice(
  _ctx: AgentPhoneContext,
  _message: AgentPhoneVoiceMessage,
): AgentPhoneVoiceResult {
  return {};
}

/** Default inbound call-ended hook: dispatch with phone-number auth. */
export function defaultOnCallEnded(
  _ctx: AgentPhoneContext,
  callEnded: AgentPhoneCallEnded,
): AgentPhoneInboundResult {
  return {
    auth: defaultAgentPhoneAuth({
      channel: "voice",
      from: callEnded.from,
      to: callEnded.to,
    }),
  };
}

/** Built-in AgentPhone event handlers for text delivery and terminal errors. */
export const defaultEvents: AgentPhoneChannelEvents = {
  async "message.completed"(event, channel, _ctx) {
    if (event.finishReason === "tool-calls" || !event.message) return;
    await channel.agentphone.sendMessage(event.message);
  },

  async "turn.failed"(event, channel, _ctx) {
    const hint = formatErrorHint(event);
    const errorId = extractErrorId(event.details);
    await channel.agentphone.sendMessage(
      [
        `I hit an error while handling your request${hint}.`,
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n"),
    );
  },

  async "session.failed"(event, channel) {
    const hint = formatErrorHint(event);
    const errorId = extractErrorId(event.details);
    await channel.agentphone.sendMessage(
      [
        `This session could not recover from an error${hint}.`,
        "",
        "Start a new message to continue.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n"),
    );
  },
};
