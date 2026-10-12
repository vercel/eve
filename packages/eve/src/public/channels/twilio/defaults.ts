import { failureNotice, replyTextOf } from "#public/channels/reply.js";
import { promptQueueEvents } from "#channel/prompt-queue.js";
import {
  postedIn,
  settleSignIn,
  showSignIn,
  signInChallengeText,
  type SignInSurface,
} from "#channel/sign-in.js";
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
import type { AskedInteraction } from "#channel/interaction-prompts.js";

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
const prompts = promptQueueEvents((channel: TwilioEventContext, request: AskedInteraction) =>
  showPrompt(channel, request),
);

/** Built-in Twilio event handlers for text delivery, sign-ins, and terminal errors. */
/** An SMS thread is one person's, so the link and code go in the message; texts can't be edited. */
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

export const defaultEvents: TwilioChannelEvents = {
  async "content.completed"({ data }, { channel }) {
    const text = replyTextOf(data);
    if (text === undefined) return;
    await channel.twilio.sendMessage(text);
  },

  async "interaction.opened"(fact, ctx) {
    const { data } = fact;
    const { channel } = ctx;
    await prompts["interaction.opened"](fact, ctx);
    await showSignIn(ctx.view, data.interactionId, twilioSignIns(channel));
  },

  "response.admitted": prompts["response.admitted"],

  async "interaction.settled"(fact, ctx) {
    const { data } = fact;
    const { channel } = ctx;
    await prompts["interaction.settled"](fact, ctx);
    await settleSignIn(ctx.view, data, twilioSignIns(channel));
  },

  async "turn.settled"({ data }, { channel }) {
    const notice = failureNotice(data, "turn");
    if (notice === undefined) return;
    await channel.twilio.sendMessage(notice);
  },

  async "session.ended"({ data }, { channel }) {
    const notice = failureNotice(data, { restart: "message" });
    if (notice === undefined) return;
    await channel.twilio.sendMessage(notice);
  },
};

async function showPrompt(channel: TwilioEventContext, request: AskedInteraction): Promise<void> {
  const body = renderTextInteraction(request);
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
