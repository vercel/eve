import type { ChannelFrom } from "#channel/channel-operations.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { createLogger } from "#internal/logging.js";
import type { SlackChannelState, SlackSessionTarget } from "#public/channels/slack/slackChannel.js";
import { slackSessionToken } from "#public/channels/slack/api.js";

const log = createLogger("slack.interactions");

/** `action_id` of the sign-in prompt's Cancel button; outside eve's `eve_input:` HITL prefix. */
export const SIGN_IN_CANCEL_ACTION_ID = "eve_sign_in:cancel";

/**
 * `action_id` of the sign-in prompt's Connect button. The button opens the sign-in URL; its click
 * also gives eve the prompt's `response_url`, the only way to remove an ephemeral prompt later.
 */
export const SIGN_IN_CONNECT_ACTION_ID = "eve_sign_in:connect";

/** The held turn a sign-in prompt's Cancel button cancels. */
export type SignInCancelTarget = SlackSessionTarget & { readonly turnId: string };

/** Reads a Cancel click's target from a sign-in prompt's button value. */
export function parseSignInCancelTarget(value: unknown): SignInCancelTarget | undefined {
  const parsed = parseObject(value);
  if (parsed === undefined) return undefined;
  const { channelId, codeChannel, threadTs, turnId } = parsed;
  if (typeof channelId !== "string" || typeof turnId !== "string") return undefined;
  if (codeChannel === true) return { channelId, codeChannel, turnId };
  return typeof threadTs === "string" ? { channelId, threadTs, turnId } : undefined;
}

/**
 * The session a sign-in prompt's Connect button belongs to, the connection it signs in to, and the
 * one Slack user the prompt was shown to.
 */
export type SignInConnectTarget = SlackSessionTarget & {
  readonly displayName: string;
  readonly name: string;
  readonly userId: string;
};

/** Reads a Connect click's target from a sign-in prompt's button value. */
export function parseSignInConnectTarget(value: unknown): SignInConnectTarget | undefined {
  const parsed = parseObject(value);
  if (parsed === undefined) return undefined;
  const { channelId, codeChannel, displayName, name, threadTs, userId } = parsed;
  if (
    typeof channelId !== "string" ||
    typeof displayName !== "string" ||
    typeof name !== "string" ||
    typeof userId !== "string"
  ) {
    return undefined;
  }
  if (codeChannel === true) return { channelId, codeChannel, displayName, name, userId };
  return typeof threadTs === "string"
    ? { channelId, displayName, name, threadTs, userId }
    : undefined;
}

/**
 * Handles a click on a sign-in prompt's Connect button: Slack opens the sign-in URL itself, eve
 * replaces the prompt with a line that has nothing to click, and records the click's
 * `response_url` in the session's channel state, so the line can be removed once the sign-in
 * ends. Only the person the prompt was shown to counts. Returns false for any other interaction.
 */
export function dispatchSignInConnect(
  raw: Record<string, unknown>,
  ctx: {
    readonly from: ChannelFrom<SlackChannelState>;
    readonly waitUntil: (task: Promise<unknown>) => void;
  },
): boolean {
  const target = parseSignInConnectTarget(findAction(raw, SIGN_IN_CONNECT_ACTION_ID)?.value);
  if (target === undefined) return false;
  const user = isObjectRecord(raw.user) ? raw.user : undefined;
  const responseUrl = raw.response_url;
  if (user?.id !== target.userId || typeof responseUrl !== "string") return true;
  ctx.waitUntil(
    Promise.all([
      rememberSignInPrompt(target, responseUrl, ctx),
      respondToSignInPrompt(responseUrl, {
        replace_original: true,
        text: `Waiting for ${target.displayName}...`,
      }),
    ]),
  );
  return true;
}

async function rememberSignInPrompt(
  target: SignInConnectTarget,
  responseUrl: string,
  ctx: { readonly from: ChannelFrom<SlackChannelState> },
): Promise<void> {
  try {
    await ctx.from(slackSessionToken(target)).patchState({
      signInPromptResponseUrls: { [target.name]: responseUrl },
    });
  } catch (error) {
    log.warn("failed to record the sign-in prompt for removal", { error, name: target.name });
  }
}

/**
 * Removes a sign-in prompt through the `response_url` of its Connect click. Best effort: Slack
 * keeps the URL for 30 minutes and five uses, and a prompt it can't remove stays on screen.
 */
export async function removeSignInPrompt(responseUrl: string): Promise<void> {
  await respondToSignInPrompt(responseUrl, { delete_original: true });
}

async function respondToSignInPrompt(
  responseUrl: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    const response = await fetch(responseUrl, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      log.warn("Slack refused to change the sign-in prompt", {
        body: await response.text(),
        status: response.status,
      });
    }
  } catch (error) {
    log.warn("failed to change the sign-in prompt", { error });
  }
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
  const target = parseSignInCancelTarget(findAction(raw, SIGN_IN_CANCEL_ACTION_ID)?.value);
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
  const removed =
    cancel.responseUrl === undefined ? undefined : removeSignInPrompt(cancel.responseUrl);
  try {
    await ctx.from(slackSessionToken(cancel.target)).cancel({ turnId });
  } catch (error) {
    if (!SessionNotActiveError.is(error) || error.retryable) {
      log.error("sign-in cancel delivery failed", { error });
    }
  }
  await removed;
}

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

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return isObjectRecord(parsed) ? parsed : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
