import type { ChannelFrom } from "#channel/channel-operations.js";
import { sendSlackResponseUrl } from "#compiled/@chat-adapter/slack/api.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { createLogger } from "#internal/logging.js";
import type { SlackChannelState, SlackSessionTarget } from "#public/channels/slack/slackChannel.js";
import { slackSessionToken, type SlackWorkspaceHandle } from "#public/channels/slack/api.js";

const log = createLogger("slack.interactions");

type SlackApiRequest = SlackWorkspaceHandle["request"];

export const SIGN_IN_CANCEL_ACTION_ID = "eve_sign_in:cancel";

export type SignInCancelTarget = SlackSessionTarget & {
  readonly turnId: string;
  readonly copy?: SignInPromptCopy;
};

export interface SignInPromptCopy {
  readonly channelId: string;
  readonly ts: string;
}

export function parseSignInCancelTarget(value: unknown): SignInCancelTarget | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { channelId, codeChannel, copy, threadTs, turnId } = parsed as Record<string, unknown>;
  if (typeof channelId !== "string" || typeof turnId !== "string") return undefined;
  let target: SignInCancelTarget;
  if (codeChannel === true) target = { channelId, codeChannel, turnId };
  else if (typeof threadTs === "string") target = { channelId, threadTs, turnId };
  else return undefined;
  const parsedCopy = parseCopy(copy);
  return parsedCopy === undefined ? target : { ...target, copy: parsedCopy };
}

function parseCopy(value: unknown): SignInPromptCopy | undefined {
  if (!isObjectRecord(value)) return undefined;
  const { channelId, ts } = value;
  return typeof channelId === "string" && typeof ts === "string" ? { channelId, ts } : undefined;
}

export function dispatchSignInCancel(
  raw: Record<string, unknown>,
  ctx: {
    readonly from: ChannelFrom<SlackChannelState>;
    readonly waitUntil: (task: Promise<unknown>) => void;
  },
  request: SlackApiRequest,
): boolean {
  const cancel = readSignInCancel(raw);
  if (cancel === undefined) return false;
  ctx.waitUntil(cancelHeldSignIn(cancel, ctx, request));
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
  request: SlackApiRequest,
): Promise<void> {
  const { copy, turnId } = cancel.target;
  try {
    await ctx.from(slackSessionToken(cancel.target)).cancel({ turnId });
  } catch (error) {
    if (!SessionNotActiveError.is(error) || error.retryable) {
      log.error("sign-in cancel delivery failed", { error });
      return;
    }
  }
  if (copy !== undefined) await closeCopy(copy, request);
  if (cancel.responseUrl === undefined) return;
  try {
    await sendSlackResponseUrl(cancel.responseUrl, { deleteOriginal: true });
  } catch (error) {
    log.warn("failed to remove the cancelled sign-in prompt", { error });
  }
}

const CANCELLED_TEXT = "Sign-in cancelled";

async function closeCopy(copy: SignInPromptCopy, request: SlackApiRequest): Promise<void> {
  const target = { channel: copy.channelId, ts: copy.ts };
  try {
    const updated = await request("chat.update", {
      ...target,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: CANCELLED_TEXT } }],
      text: CANCELLED_TEXT,
    });
    if (updated.ok === true) return;
  } catch (error) {
    log.warn("failed to close the cancelled sign-in prompt's DM copy", { error });
  }
  try {
    const deleted = await request("chat.delete", target);
    if (deleted.ok !== true) {
      log.warn("failed to remove the cancelled sign-in prompt's DM copy", {
        error: deleted.error ?? "unknown_error",
      });
    }
  } catch (error) {
    log.warn("failed to remove the cancelled sign-in prompt's DM copy", { error });
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
