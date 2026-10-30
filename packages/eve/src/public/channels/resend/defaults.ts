import type { Interaction } from "#channel/interaction-prompts.js";
import { renderTextInteraction } from "#channel/resolve-text.js";
import { postedIn, signInChallengeText, type SignInSurface } from "#channel/sign-in.js";
import { surfaceEvents } from "#channel/surface.js";
import type { SessionAuthContext } from "#channel/types.js";

import type { ResendEmail } from "#public/channels/resend/inbound.js";
import type {
  ResendChannelEvents,
  ResendContext,
  ResendEventContext,
  ResendInboundResult,
} from "#public/channels/resend/resendChannel.js";

/** Default auth projection for the sender of a received email. */
export function defaultResendAuth(email: Pick<ResendEmail, "address">): SessionAuthContext {
  return {
    attributes: { address: email.address },
    authenticator: "resend-email",
    issuer: "resend",
    principalId: `resend:${email.address}`,
    principalType: "user",
    subject: email.address,
  };
}

/**
 * Default inbound hook: dispatch with the sender's address as auth, unless the receiving mail
 * server reported a DMARC failure, which means the `From` address is likely forged.
 */
export function defaultOnEmail(_ctx: ResendContext, email: ResendEmail): ResendInboundResult {
  if (email.authentication?.dmarc === "fail") return null;
  return { auth: defaultResendAuth(email) };
}

function resendSignIns(channel: ResendEventContext): SignInSurface {
  const send = async (text: string) => {
    await channel.resend.reply(text);
    return undefined;
  };
  return {
    private: true,
    postChallenge: (signIn) => send(signInChallengeText(signIn)),
    post: send,
    posted: postedIn(channel.state, "pendingSignIns"),
  };
}

export const defaultEvents: ResendChannelEvents = surfaceEvents<ResendEventContext>({
  post: (channel, text) => channel.resend.reply(text),
  restart: "email",
  // Email has no buttons, so a reply can only answer the request it sees.
  requests: { showOne: showPrompt },
  signIns: resendSignIns,
});

async function showPrompt(channel: ResendEventContext, request: Interaction): Promise<void> {
  const body = renderTextInteraction(request.request);
  if ((request.request.options ?? []).length === 0) {
    await channel.resend.reply(body);
    return;
  }
  const instruction =
    request.request.allowFreeform === true
      ? "Reply with a number, or with your own answer."
      : "Reply with a number to choose.";
  await channel.resend.reply(`${body}\n\n${instruction}`);
}
