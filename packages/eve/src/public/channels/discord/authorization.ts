/**
 * Discord connection sign-ins. A sign-in link is a credential: whoever
 * completes it binds their account to the person who asked. In a DM the bot
 * posts the link directly. In a server the shared message carries no link or
 * code, only a button, and eve answers its press with an ephemeral message
 * that shows the challenge to the presser alone, and only when the presser is
 * the person who must sign in.
 */

import { createHash } from "node:crypto";

import { findPendingAuthorization } from "#channel/pending-authorization.js";
import type { Session } from "#channel/session.js";
import type { SignIn } from "#channel/sign-in.js";
import type { SessionAuthContext } from "#channel/types.js";
import { createLogger } from "#internal/logging.js";
import type { DiscordMessageBody } from "#public/channels/discord/api.js";
import { DISCORD_COMPONENT_TYPE } from "#public/channels/discord/hitl.js";

const log = createLogger("discord.authorization");

/** Custom id prefix of the shared sign-in message's button. */
export const DISCORD_AUTHORIZATION_CUSTOM_ID_PREFIX = "eve_auth:";

const LINK_BUTTON_STYLE = 5;
const PRIMARY_BUTTON_STYLE = 1;
const NOT_YOURS = "Only the person who needs to sign in can open this sign-in.";

/** The sign-in attempt a shared message's button names, as an opaque digest. */
export interface DiscordAuthorizationReveal {
  readonly attempt: string;
}

/** The full sign-in, link and code included, for the person signing in alone. */
export function renderDiscordAuthorizationPrompt(event: SignIn): DiscordMessageBody {
  const { displayName, url, userCode } = event;
  const content = [
    `Sign in to ${displayName} to continue.`,
    event.instructions,
    userCode ? `If ${displayName} asks for a confirmation code, enter ${userCode}.` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!url) return { content };
  return {
    components: [
      {
        components: [
          {
            label: `Sign in to ${displayName}`,
            style: LINK_BUTTON_STYLE,
            type: DISCORD_COMPONENT_TYPE.BUTTON,
            url,
          },
        ],
        type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
      },
    ],
    content,
  };
}

/** The shared sign-in message: who must sign in, and a button that shows them the challenge. */
export function renderDiscordAuthorizationStatus(event: SignIn): DiscordMessageBody {
  const userId = discordUserIdOf(event.principalId);
  const who = userId ? `<@${userId}> needs` : "Someone needs";
  return {
    components: [
      {
        components: [
          {
            custom_id: authorizationCustomId(event),
            label: "Sign in",
            style: PRIMARY_BUTTON_STYLE,
            type: DISCORD_COMPONENT_TYPE.BUTTON,
          },
        ],
        type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
      },
    ],
    content: `${who} to sign in to ${event.displayName} to continue. Only they can open the sign-in.`,
  };
}

/** Reads the sign-in attempt a button names, or `null` for any other component. */
export function readDiscordAuthorizationReveal(
  customId: string,
): DiscordAuthorizationReveal | null {
  if (!customId.startsWith(DISCORD_AUTHORIZATION_CUSTOM_ID_PREFIX)) return null;
  const attempt = customId.slice(DISCORD_AUTHORIZATION_CUSTOM_ID_PREFIX.length);
  return attempt ? { attempt } : null;
}

/**
 * Answers a press of the shared message's button with an ephemeral message.
 * The challenge comes from the session's own stream and goes back only when
 * the presser's principal is the one that must sign in; nothing the button
 * carries is trusted for identity.
 */
export async function answerDiscordAuthorizationReveal(input: {
  readonly auth: SessionAuthContext | null;
  readonly resolveSession: () => Promise<Session | undefined>;
  readonly reveal: DiscordAuthorizationReveal;
}): Promise<DiscordMessageBody> {
  if (input.auth === null) return { content: NOT_YOURS };
  let event: SignIn | undefined;
  try {
    const session = await input.resolveSession();
    event =
      session &&
      (await findPendingAuthorization(
        session,
        (candidate) => attemptDigest(candidate) === input.reveal.attempt,
      ));
  } catch (error) {
    log.error("Discord sign-in lookup failed", { error });
  }
  if (event === undefined) return { content: "This sign-in is no longer active." };
  if (input.auth.principalId !== event.principalId) return { content: NOT_YOURS };
  return renderDiscordAuthorizationPrompt(event);
}

function authorizationCustomId(event: SignIn): string {
  return `${DISCORD_AUTHORIZATION_CUSTOM_ID_PREFIX}${attemptDigest(event)}`;
}

/**
 * A fixed-length digest of one sign-in. Connection names can be long enough to
 * overflow Discord's 100-character `custom_id`, and a digest never needs
 * truncating, so the button always names its exact sign-in.
 */
function attemptDigest(event: Pick<SignIn, "interactionId" | "name">): string {
  return createHash("sha256")
    .update(JSON.stringify([event.name, event.interactionId]))
    .digest("base64url")
    .slice(0, 32);
}

/** The Discord user behind a default principal (`discord:<userId>`), when it is one. */
function discordUserIdOf(principalId: string | undefined): string | undefined {
  const match = /^discord:(\d+)$/u.exec(principalId ?? "");
  return match?.[1];
}
