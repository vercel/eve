import { renderTextInputRequest } from "#channel/resolve-text.js";
import type { SessionAuthContext } from "#channel/types.js";

import { extractErrorId, formatErrorHint } from "#internal/logging.js";
import type {
  TwilioTextMessage,
  TwilioVoiceCall,
  TwilioVoiceTranscription,
} from "#public/channels/twilio/inbound.js";
import type {
  TwilioChannelEvents,
  TwilioContext,
  TwilioInboundResult,
  TwilioVoiceResult,
} from "#public/channels/twilio/twilioChannel.js";
import type { ConnectionAuthorizationOutcome } from "#protocol/message.js";
import { displayProperName } from "#shared/display-name.js";
import type { InputRequest } from "#shared/input.js";

/** Default phone-number auth projection for Twilio webhook actors. */
function defaultTwilioAuth(input: {
  readonly from: string;
  readonly to?: string;
  readonly channel: "text" | "voice";
}): SessionAuthContext {
  const attributes: Record<string, string> = {
    channel: input.channel,
    from: input.from,
  };
  if (input.to !== undefined) attributes.to = input.to;

  return {
    attributes,
    authenticator: "twilio-webhook",
    issuer: "twilio",
    principalId: `twilio:${input.from}`,
    principalType: "user",
  };
}

/** Default inbound text hook: dispatch with Twilio phone-number auth. */
export function defaultOnText(
  _ctx: TwilioContext,
  message: TwilioTextMessage,
): TwilioInboundResult {
  return {
    auth: defaultTwilioAuth({
      channel: "text",
      from: message.from,
      to: message.to,
    }),
  };
}

/** Default inbound voice hook: accept the call with configured voice defaults. */
export function defaultOnVoice(_ctx: TwilioContext, _call: TwilioVoiceCall): TwilioVoiceResult {
  return {};
}

/** Default inbound voice hook: dispatch with Twilio phone-number auth. */
export function defaultOnVoiceTranscription(
  _ctx: TwilioContext,
  transcription: TwilioVoiceTranscription,
): TwilioInboundResult {
  return {
    auth: defaultTwilioAuth({
      channel: "voice",
      from: transcription.from,
      to: transcription.to,
    }),
  };
}

/** Built-in Twilio event handlers for text delivery, sign-ins, and terminal errors. */
export const defaultEvents: TwilioChannelEvents = {
  async "message.completed"(event, channel, _ctx) {
    if (event.finishReason === "tool-calls" || !event.message) return;
    await channel.twilio.sendMessage(event.message);
  },

  async "input.requested"(event, channel, _ctx) {
    if (event.requests.length === 0) return;
    await channel.twilio.sendMessage(renderTwilioInputRequests(event.requests));
  },

  // An SMS thread is one person's, so the link and code can go in the message.
  async "authorization.required"(event, channel, _ctx) {
    if (event.candidateId !== undefined) return;
    const challenge = event.authorization;
    await channel.twilio.sendMessage(
      [
        `Sign in to ${challenge?.displayName ?? displayProperName(event.name)} to continue.`,
        challenge?.instructions,
        challenge?.userCode ? `Code: ${challenge.userCode}` : undefined,
        challenge?.url,
      ]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join("\n\n"),
    );
  },

  async "authorization.completed"(event, channel, _ctx) {
    if (event.candidateId !== undefined) return;
    await channel.twilio.sendMessage(
      renderAuthorizationOutcome({
        displayName: event.authorization?.displayName ?? displayProperName(event.name),
        outcome: event.outcome,
        reason: event.reason,
      }),
    );
  },

  async "turn.failed"(event, channel, _ctx) {
    const hint = formatErrorHint(event);
    const errorId = extractErrorId(event.details);
    await channel.twilio.sendMessage(
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
    await channel.twilio.sendMessage(
      [
        `This session could not recover from an error${hint}.`,
        "",
        "Start a new message to continue.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n"),
    );
  },
};

// SMS has no buttons, so options are numbered. The batch goes out as one message
// because a text reply resolves against every pending request at once.
function renderTwilioInputRequests(requests: readonly InputRequest[]): string {
  const sections = requests.map(renderTextInputRequest);
  const hasOptions = requests.some((request) => (request.options ?? []).length > 0);
  if (hasOptions) {
    const freeform = requests.some((request) => request.allowFreeform === true);
    sections.push(
      [
        freeform
          ? "Reply with a number, or with your own answer."
          : "Reply with a number to choose.",
        ...(requests.length > 1 ? ["Your reply answers each of these."] : []),
      ].join(" "),
    );
  }
  return sections.join("\n\n");
}

function renderAuthorizationOutcome(input: {
  readonly displayName: string;
  readonly outcome: ConnectionAuthorizationOutcome;
  readonly reason?: string;
}): string {
  if (input.outcome === "authorized") return `${input.displayName} connected.`;
  if (input.outcome === "declined") return `${input.displayName} sign-in cancelled.`;
  const outcome = input.outcome === "timed-out" ? "timed out" : input.outcome;
  const reason = input.reason === undefined ? "" : ` (${input.reason})`;
  return `${input.displayName} sign-in ${outcome}${reason}.`;
}
