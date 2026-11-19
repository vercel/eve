import { createHash } from "node:crypto";

import { findPendingAuthorization } from "#channel/pending-authorization.js";
import type { Session } from "#channel/session.js";
import type { SignIn } from "#channel/sign-in.js";
import type { SessionAuthContext } from "#channel/types.js";
import { createLogger } from "#internal/logging.js";
import type { DiscordMessageBody } from "#public/channels/discord/api.js";
import { DISCORD_COMPONENT_TYPE } from "#public/channels/discord/hitl.js";

const log = createLogger("discord.authorization");

export const DISCORD_AUTHORIZATION_CUSTOM_ID_PREFIX = "eve_auth:";

const LINK_BUTTON_STYLE = 5;
const PRIMARY_BUTTON_STYLE = 1;
const NOT_YOURS = "Only the person who needs to sign in can open this sign-in.";

export interface DiscordAuthorizationReveal {
  readonly attempt: string;
}

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

export function readDiscordAuthorizationReveal(
  customId: string,
): DiscordAuthorizationReveal | null {
  if (!customId.startsWith(DISCORD_AUTHORIZATION_CUSTOM_ID_PREFIX)) return null;
  const attempt = customId.slice(DISCORD_AUTHORIZATION_CUSTOM_ID_PREFIX.length);
  return attempt ? { attempt } : null;
}

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

function attemptDigest(event: Pick<SignIn, "interactionId" | "name">): string {
  return createHash("sha256")
    .update(JSON.stringify([event.name, event.interactionId]))
    .digest("base64url")
    .slice(0, 32);
}

function discordUserIdOf(principalId: string | undefined): string | undefined {
  const match = /^discord:(\d+)$/u.exec(principalId ?? "");
  return match?.[1];
}
