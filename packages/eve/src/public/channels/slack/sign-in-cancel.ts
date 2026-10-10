import type { ChannelFrom } from "#channel/channel-operations.js";
import { createLogger } from "#internal/logging.js";
import type { SlackChannelState } from "#public/channels/slack/slackChannel.js";
import { slackContinuationToken } from "#public/channels/slack/api.js";

const log = createLogger("slack.interactions");

/** `action_id` of the sign-in prompt's Cancel button; outside eve's `eve_input:` HITL prefix. */
export const SIGN_IN_CANCEL_ACTION_ID = "eve_sign_in:cancel";

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
  try {
    await fetch(cancel.responseUrl, {
      body: JSON.stringify({ delete_original: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch (error) {
    log.warn("failed to remove the cancelled sign-in prompt", { error });
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
