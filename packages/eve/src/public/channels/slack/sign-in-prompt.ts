import type { ChannelFrom } from "#channel/channel-operations.js";
import { createLogger } from "#internal/logging.js";
import type { SlackChannelState } from "#public/channels/slack/slackChannel.js";
import { slackContinuationToken } from "#public/channels/slack/api.js";

const log = createLogger("slack.interactions");

/** `action_id` of the sign-in prompt's Cancel button; outside eve's `eve_input:` HITL prefix. */
export const SIGN_IN_CANCEL_ACTION_ID = "eve_sign_in:cancel";

/** `action_id` of the sign-in prompt's Connect link button, so its click removes the prompt. */
export const SIGN_IN_CONNECT_ACTION_ID = "eve_sign_in:connect";

/** The held turn a sign-in prompt's Cancel button cancels. */
export interface SignInCancelTarget {
  readonly channelId: string;
  readonly threadTs: string;
  readonly turnId: string;
}

/** Reads a Cancel click's target from a sign-in prompt's button value. */
export function parseSignInCancelTarget(value: unknown): SignInCancelTarget | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { channelId, threadTs, turnId } = parsed as Record<string, unknown>;
  if (typeof channelId !== "string" || typeof threadTs !== "string" || typeof turnId !== "string") {
    return undefined;
  }
  return { channelId, threadTs, turnId };
}

/**
 * Handles a click on a sign-in prompt's Connect or Cancel button in the background.
 * Returns false for any other interaction.
 */
export function dispatchSignInPromptAction(
  raw: Record<string, unknown>,
  ctx: {
    readonly from: ChannelFrom<SlackChannelState>;
    readonly waitUntil: (task: Promise<unknown>) => void;
  },
): boolean {
  const responseUrl = typeof raw.response_url === "string" ? raw.response_url : undefined;
  // Slack opens the link itself; the click only tells eve the prompt has served its purpose.
  if (findAction(raw, SIGN_IN_CONNECT_ACTION_ID) !== undefined) {
    if (responseUrl !== undefined) ctx.waitUntil(removePrompt(responseUrl));
    return true;
  }
  const target = parseSignInCancelTarget(findAction(raw, SIGN_IN_CANCEL_ACTION_ID)?.value);
  if (target === undefined) return false;
  ctx.waitUntil(cancelHeldSignIn({ responseUrl, target }, ctx));
  return true;
}

interface SignInCancel {
  readonly responseUrl: string | undefined;
  readonly target: SignInCancelTarget;
}

/**
 * The prompt is ephemeral, so the payload has no message: the Cancel target
 * rides on the button value, and only `response_url` can remove the prompt.
 */
function findAction(
  raw: Record<string, unknown>,
  actionId: string,
): Record<string, unknown> | undefined {
  const actions = Array.isArray(raw.actions) ? (raw.actions as unknown[]) : [];
  return actions.find(
    (entry): entry is Record<string, unknown> =>
      isObjectRecord(entry) && entry.action_id === actionId,
  );
}

/** Cancels the turn held on the sign-in, then removes the private prompt. */
async function cancelHeldSignIn(
  cancel: SignInCancel,
  ctx: { readonly from: ChannelFrom<SlackChannelState> },
): Promise<void> {
  const { channelId, threadTs, turnId } = cancel.target;
  try {
    await ctx.from(slackContinuationToken(channelId, threadTs)).cancel({ turnId });
  } catch (error) {
    log.error("sign-in cancel delivery failed", { error });
    return;
  }
  if (cancel.responseUrl === undefined) return;
  await removePrompt(cancel.responseUrl);
}

async function removePrompt(responseUrl: string): Promise<void> {
  try {
    await fetch(responseUrl, {
      body: JSON.stringify({ delete_original: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch (error) {
    log.warn("failed to remove the sign-in prompt", { error });
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
