/**
 * Suggested prompts for Slack assistant/agent conversations.
 *
 * The channel applies the configured prompts via
 * `assistant.threads.setSuggestedPrompts` when the user opens the
 * conversation. Which event signals that depends on the Slack app's
 * manifest mode:
 *
 * - `agent_view` (current Agent messaging experience): `app_home_opened`
 *   with `tab: "messages"`. Prompts render at the top of the Messages
 *   tab and are not tied to a thread, so no `thread_ts` is sent.
 * - `assistant_view` (legacy): `assistant_thread_started`. Prompts
 *   render inside the newly opened assistant thread, targeted by
 *   `thread_ts`.
 *
 * Configured via `slackChannel({ suggestedPrompts })`; requires the
 * `assistant:write` scope and a subscription to the relevant event.
 */

import type { SlackApiResponse } from "#public/channels/slack/api.js";
import type { SlackEvent } from "#public/channels/slack/inbound.js";

import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("slack.suggested-prompts");

/** Slack caps `assistant.threads.setSuggestedPrompts` at four prompts. */
export const SLACK_MAX_SUGGESTED_PROMPTS = 4;

/** One suggested prompt shown when the conversation opens. */
export interface SlackSuggestedPrompt {
  /** Short label rendered on the prompt. */
  readonly title: string;
  /** Message sent as the user's turn when the prompt is clicked. */
  readonly message: string;
}

/** Suggested prompts payload applied when the conversation opens. */
export interface SlackSuggestedPromptsInput {
  /** Optional heading rendered above the prompt list. */
  readonly title?: string;
  /**
   * Up to {@link SLACK_MAX_SUGGESTED_PROMPTS} prompts; extras are
   * dropped with a warning.
   */
  readonly prompts: readonly SlackSuggestedPrompt[];
}

/**
 * Context handed to a dynamic `suggestedPrompts` resolver, extracted
 * from the triggering event.
 */
export interface SlackSuggestedPromptsContext {
  /** DM channel the conversation lives in. */
  readonly channelId: string;
  /**
   * Assistant thread root ts. Only present for the legacy
   * `assistant_thread_started` trigger — under `agent_view` prompts
   * apply to the whole Messages tab, not a thread.
   */
  readonly threadTs: string | undefined;
  /** Slack user who opened the conversation. */
  readonly userId: string | undefined;
  /** Slack team id, when the envelope carried one. */
  readonly teamId: string | undefined;
  /** The normalized triggering event. */
  readonly event: SlackEvent;
}

/**
 * `slackChannel({ suggestedPrompts })` value: a static payload, or a
 * resolver invoked each time a conversation opens. Return
 * `null`/`undefined` from the resolver to skip that open.
 */
export type SlackSuggestedPrompts =
  | SlackSuggestedPromptsInput
  | ((
      context: SlackSuggestedPromptsContext,
    ) =>
      | SlackSuggestedPromptsInput
      | null
      | undefined
      | Promise<SlackSuggestedPromptsInput | null | undefined>);

/**
 * True when `event` signals a user opening the assistant/agent
 * conversation, i.e. when the channel should apply suggested prompts.
 */
export function isSuggestedPromptsTrigger(event: SlackEvent): boolean {
  return resolvePromptsTarget(event) !== null;
}

/**
 * Resolves the configured prompts for one conversation-open event and
 * applies them via `assistant.threads.setSuggestedPrompts`. Errors and
 * not-ok responses are logged and swallowed: suggested prompts are a
 * UX nicety, never a reason to fail the webhook.
 */
export async function applySuggestedPrompts(input: {
  readonly suggestedPrompts: SlackSuggestedPrompts;
  readonly event: SlackEvent;
  readonly request: (operation: string, body: unknown) => Promise<SlackApiResponse>;
}): Promise<void> {
  const { event } = input;
  const target = resolvePromptsTarget(event);
  if (target === null) return;

  try {
    const resolved =
      typeof input.suggestedPrompts === "function"
        ? await input.suggestedPrompts({ ...target, teamId: event.teamId, event })
        : input.suggestedPrompts;
    if (!resolved || resolved.prompts.length === 0) return;

    let prompts = resolved.prompts;
    if (prompts.length > SLACK_MAX_SUGGESTED_PROMPTS) {
      log.warn("suggested prompts exceed Slack's cap — extras dropped", {
        configured: prompts.length,
        cap: SLACK_MAX_SUGGESTED_PROMPTS,
      });
      prompts = prompts.slice(0, SLACK_MAX_SUGGESTED_PROMPTS);
    }

    const body: Record<string, unknown> = {
      channel_id: target.channelId,
      prompts: prompts.map((prompt) => ({
        title: prompt.title,
        message: prompt.message,
      })),
    };
    if (target.threadTs !== undefined) body.thread_ts = target.threadTs;
    if (resolved.title !== undefined) body.title = resolved.title;

    const response = await input.request("assistant.threads.setSuggestedPrompts", body);
    if (response.ok !== true) {
      log.warn("assistant.threads.setSuggestedPrompts returned not-ok", {
        error: response.error,
        channel_id: target.channelId,
      });
    }
  } catch (error) {
    logError(log, "suggested prompts delivery failed", error, {
      channelId: target.channelId,
    });
  }
}

interface PromptsTarget {
  readonly channelId: string;
  readonly threadTs: string | undefined;
  readonly userId: string | undefined;
}

/**
 * Extracts the prompts delivery target from a conversation-open event,
 * or `null` when the event is not one (including `app_home_opened` for
 * tabs other than Messages).
 */
function resolvePromptsTarget(event: SlackEvent): PromptsTarget | null {
  if (event.type === "assistant_thread_started") {
    const thread = event.event.assistant_thread;
    if (typeof thread !== "object" || thread === null || Array.isArray(thread)) {
      log.warn("assistant_thread_started event carried no assistant_thread", {
        event_id: event.eventId,
      });
      return null;
    }
    const { channel_id, thread_ts, user_id } = thread as Record<string, unknown>;
    if (typeof channel_id !== "string" || channel_id.length === 0) return null;
    return {
      channelId: channel_id,
      threadTs: typeof thread_ts === "string" && thread_ts.length > 0 ? thread_ts : undefined,
      userId: typeof user_id === "string" && user_id.length > 0 ? user_id : undefined,
    };
  }

  if (event.type === "app_home_opened") {
    // Under agent_view the Messages tab is the conversation surface;
    // opening the Home (or About) tab is not a prompts trigger.
    if (event.event.tab !== "messages") return null;
    const { channel, user } = event.event;
    if (typeof channel !== "string" || channel.length === 0) return null;
    return {
      channelId: channel,
      threadTs: undefined,
      userId: typeof user === "string" && user.length > 0 ? user : undefined,
    };
  }

  return null;
}
