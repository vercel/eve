import { errorHintOf, replyTextOf } from "#public/channels/reply.js";
import { promptQueueEvents } from "#channel/prompt-queue.js";
import { signInPromptOf, signInSettlementOf } from "#channel/interaction-prompts.js";
import { renderTextInputRequest } from "#channel/resolve-text.js";
import type { SessionAuthContext } from "#channel/types.js";

import { formatErrorHint } from "#internal/logging.js";
import type {
  TwilioTextMessage,
  TwilioVoiceCall,
  TwilioVoiceTranscription,
} from "#public/channels/twilio/inbound.js";
import type {
  TwilioChannelEvents,
  TwilioContext,
  TwilioEventContext,
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

// SMS has no buttons, so a reply can only answer the request it sees.
const prompts = promptQueueEvents((channel: TwilioEventContext, request: InputRequest) =>
  showPrompt(channel, request),
);

/** Built-in Twilio event handlers for text delivery, sign-ins, and terminal errors. */
export const defaultEvents: TwilioChannelEvents = {
  async "content.completed"(event, channel, _ctx) {
    const text = replyTextOf(event);
    if (text === undefined) return;
    await channel.twilio.sendMessage(text);
  },

  // An SMS thread is one person's, so the link and code can go in the message.
  async "interaction.opened"(data, channel, ctx) {
    await prompts["interaction.opened"](data, channel, ctx);
    const event = signInPromptOf(data, ctx.scope);
    if (event === undefined) return;
    if (event.responseId !== undefined) return;
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

  async "interaction.settled"(data, channel, ctx) {
    await prompts["interaction.settled"](data, channel, ctx);
    const event = signInSettlementOf(ctx.view, data);
    if (event === undefined) return;
    if (event.responseId !== undefined) return;
    await channel.twilio.sendMessage(
      renderAuthorizationOutcome({
        displayName: event.authorization?.displayName ?? displayProperName(event.name),
        outcome: event.outcome,
        reason: event.reason,
      }),
    );
  },

  async "turn.settled"(event, channel, _ctx) {
    if (event.outcome !== "failed") return;
    const hint = formatErrorHint(errorHintOf(event.error));
    const errorId = event.error?.id;
    await channel.twilio.sendMessage(
      [
        `I hit an error while handling your request${hint}.`,
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n"),
    );
  },

  async "session.ended"(event, channel, _ctx) {
    if (event.outcome !== "failed") return;
    const hint = formatErrorHint(errorHintOf(event.error));
    const errorId = event.error?.id;
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

async function showPrompt(channel: TwilioEventContext, request: InputRequest): Promise<void> {
  const body = renderTextInputRequest(request);
  if ((request.options ?? []).length === 0) {
    await channel.twilio.sendMessage(body);
    return;
  }
  const instruction =
    request.allowFreeform === true
      ? "Reply with a number, or with your own answer."
      : "Reply with a number to choose.";
  await channel.twilio.sendMessage(`${body}\n\n${instruction}`);
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
