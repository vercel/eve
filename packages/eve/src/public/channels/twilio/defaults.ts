import { postedIn, signInChallengeText, type SignInSurface } from "#channel/sign-in.js";
import { surfaceEvents } from "#channel/surface.js";
import { renderTextInteraction } from "#channel/resolve-text.js";
import type { SessionAuthContext } from "#channel/types.js";

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
import type { Interaction } from "#channel/interaction-prompts.js";

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

function twilioSignIns(channel: TwilioEventContext): SignInSurface {
  const send = async (text: string) => {
    await channel.twilio.sendMessage(text);
    return undefined;
  };
  return {
    private: true,
    postChallenge: (signIn) => send(signInChallengeText(signIn)),
    post: send,
    posted: postedIn(channel.state, "pendingSignIns"),
  };
}

export const defaultEvents: TwilioChannelEvents = surfaceEvents<TwilioEventContext>({
  post: (channel, text) => channel.twilio.sendMessage(text),
  restart: "message",
  // SMS has no buttons, so a reply can only answer the request it sees.
  requests: { showOne: showPrompt },
  signIns: twilioSignIns,
});

async function showPrompt(channel: TwilioEventContext, request: Interaction): Promise<void> {
  const body = renderTextInteraction(request.request);
  if ((request.request.options ?? []).length === 0) {
    await channel.twilio.sendMessage(body);
    return;
  }
  const instruction =
    request.request.allowFreeform === true
      ? "Reply with a number, or with your own answer."
      : "Reply with a number to choose.";
  await channel.twilio.sendMessage(`${body}\n\n${instruction}`);
}
