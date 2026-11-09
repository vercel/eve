import type { ChannelFrom } from "#channel/channel-operations.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { createLogger } from "#internal/logging.js";
import type { SlackChannelState, SlackSessionTarget } from "#public/channels/slack/slackChannel.js";
import { slackSessionToken } from "#public/channels/slack/api.js";

const log = createLogger("slack.interactions");

/** `action_id` of the sign-in prompt's Cancel button; outside eve's `eve_input:` HITL prefix. */
export const SIGN_IN_CANCEL_ACTION_ID = "eve_sign_in:cancel";

/**
 * `action_id` of the sign-in prompt's Connect link button. Slack opens the link
 * and also sends a `block_actions` click, whose `response_url` is the only way
 * to remove an ephemeral prompt.
 */
export const SIGN_IN_CONNECT_ACTION_ID = "eve_sign_in:connect";

/** The held turn a sign-in prompt's Cancel button cancels. */
export type SignInCancelTarget = SlackSessionTarget & { readonly turnId: string };

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
  const { channelId, codeChannel, threadTs, turnId } = parsed as Record<string, unknown>;
  if (typeof channelId !== "string" || typeof turnId !== "string") return undefined;
  if (codeChannel === true) return { channelId, codeChannel, turnId };
  return typeof threadTs === "string" ? { channelId, threadTs, turnId } : undefined;
}

/**
 * Handles a click on a sign-in prompt's Cancel button in the background.
 * Returns false for any other interaction.
 */
export function dispatchSignInCancel(
  raw: Record<string, unknown>,
  ctx: {
    readonly from: ChannelFrom<SlackChannelState>;
    readonly waitUntil: (task: Promise<unknown>) => void;
  },
): boolean {
  const cancel = readSignInCancel(raw);
  if (cancel === undefined) return false;
  ctx.waitUntil(cancelHeldSignIn(cancel, ctx));
  return true;
}

/**
 * Removes the private sign-in prompt in the background once its Connect button
 * is clicked; the sign-in finishes in the browser tab Slack opened, and the
 * public status shows how it ended. Returns false for any other interaction.
 */
export function dispatchSignInConnect(
  raw: Record<string, unknown>,
  ctx: { readonly waitUntil: (task: Promise<unknown>) => void },
): boolean {
  const actions = Array.isArray(raw.actions) ? (raw.actions as unknown[]) : [];
  const clicked = actions.some(
    (entry) => isObjectRecord(entry) && entry.action_id === SIGN_IN_CONNECT_ACTION_ID,
  );
  if (!clicked) return false;
  if (typeof raw.response_url === "string") ctx.waitUntil(removePrompt(raw.response_url));
  return true;
}

interface SignInCancel {
  readonly responseUrl: string | undefined;
  readonly target: SignInCancelTarget;
}

/**
 * Reads a click on a sign-in prompt's Cancel button. The prompt is ephemeral,
 * so the payload has no message; its target rides on the button value.
 */
function readSignInCancel(raw: Record<string, unknown>): SignInCancel | undefined {
  const actions = Array.isArray(raw.actions) ? (raw.actions as unknown[]) : [];
  const action = actions.find(
    (entry): entry is Record<string, unknown> =>
      isObjectRecord(entry) && entry.action_id === SIGN_IN_CANCEL_ACTION_ID,
  );
  const target = parseSignInCancelTarget(action?.value);
  if (target === undefined) return undefined;
  return {
    responseUrl: typeof raw.response_url === "string" ? raw.response_url : undefined,
    target,
  };
}

/**
 * Removes the private prompt, then cancels the turn held on the sign-in. The
 * prompt goes whatever the cancel's outcome, because a click on Cancel always
 * means the person is done with it.
 */
async function cancelHeldSignIn(
  cancel: SignInCancel,
  ctx: { readonly from: ChannelFrom<SlackChannelState> },
): Promise<void> {
  const { turnId } = cancel.target;
  const removed = cancel.responseUrl === undefined ? undefined : removePrompt(cancel.responseUrl);
  try {
    await ctx.from(slackSessionToken(cancel.target)).cancel({ turnId });
  } catch (error) {
    if (!SessionNotActiveError.is(error) || error.retryable) {
      log.error("sign-in cancel delivery failed", { error });
    }
  }
  await removed;
}

async function removePrompt(responseUrl: string): Promise<void> {
  try {
    const response = await fetch(responseUrl, {
      body: JSON.stringify({ delete_original: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      log.warn("Slack refused to remove the sign-in prompt", {
        body: await response.text(),
        status: response.status,
      });
    }
  } catch (error) {
    log.warn("failed to remove the sign-in prompt", { error });
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
