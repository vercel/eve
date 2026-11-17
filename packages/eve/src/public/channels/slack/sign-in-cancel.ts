import type { ChannelFrom } from "#channel/channel-operations.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { createLogger } from "#internal/logging.js";
import type { SlackChannelState, SlackSessionTarget } from "#public/channels/slack/slackChannel.js";
import { slackSessionToken } from "#public/channels/slack/api.js";

const log = createLogger("slack.interactions");

export const SIGN_IN_CANCEL_ACTION_ID = "eve_sign_in:cancel";

export type SignInCancelTarget = SlackSessionTarget & { readonly turnId: string };

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

async function cancelHeldSignIn(
  cancel: SignInCancel,
  ctx: { readonly from: ChannelFrom<SlackChannelState> },
): Promise<void> {
  const { turnId } = cancel.target;
  try {
    await ctx.from(slackSessionToken(cancel.target)).cancel({ turnId });
  } catch (error) {
    if (!SessionNotActiveError.is(error) || error.retryable) {
      log.error("sign-in cancel delivery failed", { error });
      return;
    }
  }
  if (cancel.responseUrl === undefined) return;
  try {
    const response = await fetch(cancel.responseUrl, {
      body: JSON.stringify({ delete_original: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      log.warn("Slack refused to remove the cancelled sign-in prompt", {
        body: await response.text(),
        status: response.status,
      });
    }
  } catch (error) {
    log.warn("failed to remove the cancelled sign-in prompt", { error });
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
