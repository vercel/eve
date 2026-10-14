/**
 * Teams connection sign-in cards. A sign-in link is a credential: whoever
 * completes it binds their account to the person who asked. Outside personal
 * chats the shared card carries no link or code, only an `Action.Execute`
 * button; Teams shows the invoke's response card to the presser alone, and
 * eve answers with the challenge only when the presser is that person.
 */

import type { Session } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationRequiredStreamEvent } from "#protocol/message.js";
import type { TeamsChannelAccount, TeamsMessageBody } from "#public/channels/teams/api.js";
import { TEAMS_ADAPTIVE_CARD_CONTENT_TYPE } from "#public/channels/teams/hitl.js";
import type { TeamsInvokeActivity } from "#public/channels/teams/inbound.js";
import { createLogger } from "#internal/logging.js";
import { displayProperName } from "#shared/display-name.js";
import { isObject } from "#shared/guards.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

const log = createLogger("teams.authorization");

type AuthorizationRequired = AuthorizationRequiredStreamEvent["data"];

/** Hidden data property carried by the shared sign-in card's button. */
const TEAMS_AUTHORIZATION_DATA_KEY = "eve_authorization";

/** Identifies one sign-in attempt from the shared card's button press. */
export interface TeamsAuthorizationReveal {
  readonly attemptId?: string;
  readonly name: string;
  readonly replyToActivityId?: string;
}

/** A connection's display name for its sign-in card (`linear` → `Linear`). */
export function teamsAuthorizationDisplayName(event: AuthorizationRequired): string {
  return event.authorization?.displayName ?? displayProperName(event.name);
}

/** The full sign-in card, link and code included, for the person signing in alone. */
export function renderTeamsAuthorizationPrompt(
  event: AuthorizationRequired,
  options: { readonly adaptiveCardVersion: string; readonly requester: string | undefined },
): TeamsMessageBody {
  const displayName = teamsAuthorizationDisplayName(event);
  const url = event.authorization?.url;
  const instructions = event.authorization?.instructions;
  const userCode = event.authorization?.userCode;
  const codeHint = userCode
    ? `If ${displayName} asks for a confirmation code, enter ${userCode}.`
    : undefined;
  const text = [
    url
      ? `Authorization required for ${displayName}: ${url}`
      : `Authorization required for ${displayName}.`,
    instructions,
    codeHint,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    attachments: [
      adaptiveCard(options.adaptiveCardVersion, {
        actions: url ? [{ title: `Sign in with ${displayName}`, type: "Action.OpenUrl", url }] : [],
        body: [
          heading(`Authorization required for ${displayName}`),
          textBlock(
            options.requester
              ? `Requested by ${options.requester}.`
              : "No triggering user is available for a private prompt.",
          ),
          ...[instructions, codeHint]
            .filter((line): line is string => Boolean(line))
            .map((line) => textBlock(line)),
        ],
      }),
    ],
    text,
  };
}

/** The shared sign-in card: who must sign in, and a button that shows them the challenge. */
export function renderTeamsAuthorizationStatus(
  event: AuthorizationRequired,
  options: {
    readonly adaptiveCardVersion: string;
    readonly replyToActivityId: string | undefined;
    readonly requester: string | undefined;
  },
): TeamsMessageBody {
  const displayName = teamsAuthorizationDisplayName(event);
  const notice = options.requester
    ? `${options.requester} must sign in to continue. Only they can open the sign-in.`
    : "Only the person who needs to sign in can open it.";
  const reveal: TeamsAuthorizationReveal = {
    attemptId: event.attemptId,
    name: event.name,
    replyToActivityId: options.replyToActivityId,
  };
  const text = `Authorization required for ${displayName}. ${notice}`;
  return {
    attachments: [
      adaptiveCard(options.adaptiveCardVersion, {
        actions: [
          {
            data: { [TEAMS_AUTHORIZATION_DATA_KEY]: reveal },
            title: "Sign in",
            type: "Action.Execute",
            verb: "eve.authorization.reveal",
          },
        ],
        body: [heading(`Authorization required for ${displayName}`), textBlock(notice)],
      }),
    ],
    text,
  };
}

/** Reads the sign-in attempt a shared card's button names, or `null` for other invokes. */
export function readTeamsAuthorizationReveal(
  activity: TeamsInvokeActivity,
): TeamsAuthorizationReveal | null {
  const action = isObject(activity.value?.action) ? activity.value.action : null;
  const data = action && isObject(action.data) ? action.data : null;
  const reveal = data?.[TEAMS_AUTHORIZATION_DATA_KEY];
  if (!isObject(reveal) || typeof reveal.name !== "string") return null;
  return {
    attemptId: typeof reveal.attemptId === "string" ? reveal.attemptId : undefined,
    name: reveal.name,
    replyToActivityId:
      typeof reveal.replyToActivityId === "string" ? reveal.replyToActivityId : undefined,
  };
}

/**
 * Answers a press of the shared card's button. The challenge comes from the
 * session's own stream and goes back only when the presser's principal is the
 * one that must sign in; nothing the card carries is trusted for identity.
 */
export async function answerTeamsAuthorizationReveal(input: {
  readonly adaptiveCardVersion: string;
  readonly auth: SessionAuthContext | null;
  readonly presser: TeamsChannelAccount;
  readonly resolveSession: () => Promise<Session | undefined>;
  readonly reveal: TeamsAuthorizationReveal;
}): Promise<JsonObject> {
  let event: AuthorizationRequired | undefined;
  try {
    const session = await input.resolveSession();
    event = session && (await findPendingAuthorization(session, input.reveal));
  } catch (error) {
    log.error("Teams sign-in lookup failed", { error });
  }
  if (event === undefined) return invokeMessage("This sign-in is no longer active.");
  if (input.auth === null || input.auth.principalId !== event.principalId) {
    return invokeMessage("Only the person who needs to sign in can open this sign-in.");
  }
  const prompt = renderTeamsAuthorizationPrompt(event, {
    adaptiveCardVersion: input.adaptiveCardVersion,
    requester: input.presser.name ?? input.presser.id,
  });
  return parseJsonObject({
    statusCode: 200,
    type: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
    value: prompt.attachments?.[0]?.content,
  });
}

async function findPendingAuthorization(
  session: Session,
  reveal: TeamsAuthorizationReveal,
): Promise<AuthorizationRequired | undefined> {
  const tailIndex = await session.getStreamTailIndex();
  if (tailIndex < 0) return undefined;
  const reader = (await session.getEventStream({ startIndex: 0 })).getReader();
  let pending: AuthorizationRequired | undefined;
  try {
    for (let index = 0; index <= tailIndex; index += 1) {
      const next = await reader.read();
      if (next.done) break;
      const event = next.value;
      if (event.type !== "authorization.required" && event.type !== "authorization.completed") {
        continue;
      }
      if (event.data.name !== reveal.name || event.data.attemptId !== reveal.attemptId) continue;
      pending = event.type === "authorization.required" ? event.data : undefined;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return pending;
}

function invokeMessage(message: string): JsonObject {
  return { statusCode: 200, type: "application/vnd.microsoft.activity.message", value: message };
}

function adaptiveCard(
  version: string,
  card: { readonly actions: readonly object[]; readonly body: readonly object[] },
) {
  return {
    content: parseJsonObject({
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      ...card,
      type: "AdaptiveCard",
      version,
    }),
    contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
  };
}

function heading(text: string) {
  return { text, type: "TextBlock", weight: "Bolder", wrap: true };
}

function textBlock(text: string) {
  return { text, type: "TextBlock", wrap: true };
}
