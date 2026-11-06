import type { ChannelResolveSession } from "#channel/channel-operations.js";
import { signInOf } from "#channel/sign-in.js";
import { createLogger } from "#internal/logging.js";
import { emptySessionView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
import { slackSessionToken } from "#public/channels/slack/api.js";
import {
  buildAuthCompletedText,
  SIGN_IN_CONNECT_ACTION_ID,
  type SignInConnectTarget,
} from "#public/channels/slack/connections.js";

const log = createLogger("slack.interactions");

// The sign-in opened near the tail before the prompt was posted, as for the other channels'
// pending-authorization lookups; reading from there also catches one settled before the click.
const SIGN_IN_WINDOW = 500;

// Slack accepts a `response_url` for 30 minutes; a sign-in finished later can't reach the prompt.
const RESPONSE_URL_LIFETIME_MS = 30 * 60 * 1000;

/** Reads a Connect click's target from a sign-in prompt's button value. */
export function parseSignInConnectTarget(value: unknown): SignInConnectTarget | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { channelId, codeChannel, interactionId, threadTs } = parsed as Record<string, unknown>;
  if (typeof channelId !== "string" || typeof interactionId !== "string") return undefined;
  if (codeChannel === true) return { channelId, codeChannel, interactionId };
  return typeof threadTs === "string" ? { channelId, interactionId, threadTs } : undefined;
}

/**
 * Handles a click on a sign-in prompt's Connect button in the background: once the sign-in
 * settles, the private prompt shows how it ended. Slack can't edit an ephemeral message except
 * through the `response_url` of a click on it, and the session can't hold that URL while its turn
 * waits, so the click's handler follows the session until the sign-in settles. It only reads.
 * Returns false for any other interaction.
 */
export function dispatchSignInConnect(
  raw: Record<string, unknown>,
  ctx: {
    readonly resolveSession: ChannelResolveSession;
    readonly waitUntil: (task: Promise<unknown>) => void;
  },
): boolean {
  const connect = readSignInConnect(raw);
  if (connect === undefined) return false;
  if (connect.responseUrl !== undefined) {
    ctx.waitUntil(showSettledSignIn({ ...connect, responseUrl: connect.responseUrl }, ctx));
  }
  return true;
}

interface SignInConnect {
  readonly responseUrl: string | undefined;
  readonly target: SignInConnectTarget;
}

function readSignInConnect(raw: Record<string, unknown>): SignInConnect | undefined {
  const actions = Array.isArray(raw.actions) ? (raw.actions as unknown[]) : [];
  const action = actions.find(
    (entry): entry is Record<string, unknown> =>
      isObjectRecord(entry) && entry.action_id === SIGN_IN_CONNECT_ACTION_ID,
  );
  if (action === undefined) return undefined;
  const target = parseSignInConnectTarget(action.value);
  if (target === undefined) return undefined;
  return {
    responseUrl: typeof raw.response_url === "string" ? raw.response_url : undefined,
    target,
  };
}

async function showSettledSignIn(
  connect: SignInConnect & { readonly responseUrl: string },
  ctx: { readonly resolveSession: ChannelResolveSession },
): Promise<void> {
  const { interactionId } = connect.target;
  let text: string | undefined;
  try {
    const session = await ctx.resolveSession(slackSessionToken(connect.target));
    if (session === undefined) return;
    const view = emptySessionView();
    for await (const event of session.stream({
      signal: AbortSignal.timeout(RESPONSE_URL_LIFETIME_MS),
      startIndex: -SIGN_IN_WINDOW,
    })) {
      foldReceivedEvent(view, event);
      if (event.type !== "interaction.settled" || event.data.interactionId !== interactionId) {
        continue;
      }
      const signIn = signInOf(view, interactionId);
      if (signIn === undefined) return;
      text = buildAuthCompletedText({
        displayName: signIn.displayName,
        outcome: event.data.outcome,
        reason: event.data.reason,
      });
      break;
    }
  } catch (error) {
    log.warn("stopped following a sign-in for its Slack prompt", { error, interactionId });
    return;
  }
  if (text === undefined) return;
  try {
    const response = await fetch(connect.responseUrl, {
      body: JSON.stringify({ replace_original: true, text }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      log.warn("Slack refused to update the settled sign-in prompt", {
        body: await response.text(),
        status: response.status,
      });
    }
  } catch (error) {
    log.warn("failed to update the settled sign-in prompt", { error });
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
