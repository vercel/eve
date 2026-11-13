import { createHash } from "node:crypto";

import { createLogger } from "#internal/logging.js";
import type { SlackApiResponse } from "#public/channels/slack/api.js";
import type { SlackChannelContext } from "#public/channels/slack/slackChannel.js";

const log = createLogger("slack.code-channel-surfaces");

/** Slack keeps one diff view per channel, up to this many bytes. */
export const SLACK_DIFF_VIEW_MAX_BYTES = 1_000_000;

/**
 * One item of a code channel's context bar, the row of links under the
 * channel header. Slack identifies items by `key`.
 */
export interface SlackCodeChannelContextBarItem {
  readonly key: string;
  readonly label: string;
  /** A Slack icon name, such as `folder`, `branch`, `code`, `hierarchy`, or `terminal`. */
  readonly icon?: string;
  readonly url?: string;
}

/** A code channel's diff view: a unified diff, as `git diff` prints it. */
export interface SlackCodeChannelDiffView {
  readonly content: string;
  readonly baseBranch?: string;
  readonly headBranch?: string;
}

/**
 * What a code channel shows now, kept in the session's channel state so an
 * unchanged update doesn't call Slack.
 * @internal
 */
export interface SlackCodeChannelSurfacesState {
  contextBar?: string;
  diff?: string;
  diffViewId?: string;
}

type SurfaceChannel = Pick<SlackChannelContext, "slack" | "state">;

/**
 * Replaces a code channel's context bar with `items`. Calls Slack only when
 * the items changed since the last call. Outside a code channel it does
 * nothing.
 *
 * Returns whether the channel shows `items`; Slack refusing is logged, not thrown.
 */
export async function setCodeChannelContextBar(
  channel: SurfaceChannel,
  items: readonly SlackCodeChannelContextBarItem[],
): Promise<boolean> {
  if (!channel.slack.codeChannel) return false;
  const shown = surfaces(channel);
  const contextBar = fingerprint(items);
  if (contextBar === shown.contextBar) return true;
  const response = await channel.slack.request("agents.conversations.setProperties", {
    channel_id: channel.slack.channelId,
    code_channel: { context_bar_items: items },
  });
  if (!succeeded("agents.conversations.setProperties", response)) return false;
  shown.contextBar = contextBar;
  return true;
}

/**
 * Shows `view` as the code channel's diff view, or takes the view down for
 * `null` or an empty diff. Calls Slack only when the diff changed since the
 * last call. Outside a code channel it does nothing.
 *
 * A diff over Slack's limit is cut at the last whole file that fits. When not
 * even the first file fits, the previous view stays up.
 *
 * Returns whether the channel shows `view`; Slack refusing is logged, not thrown.
 */
export async function setCodeChannelDiffView(
  channel: SurfaceChannel,
  view: SlackCodeChannelDiffView | null,
): Promise<boolean> {
  if (!channel.slack.codeChannel) return false;
  const shown = surfaces(channel);
  if (view === null || view.content === "") {
    if (shown.diffViewId === undefined) return true;
    const response = await channel.slack.request("agents.conversations.removeView", {
      channel_id: channel.slack.channelId,
      view_id: shown.diffViewId,
    });
    if (
      response.error !== "view_not_found" &&
      !succeeded("agents.conversations.removeView", response)
    ) {
      return false;
    }
    delete shown.diff;
    delete shown.diffViewId;
    return true;
  }
  const content = truncateDiff(view.content);
  if (content === undefined) {
    log.warn("Diff view left unchanged: its first file is over Slack's size limit");
    return false;
  }
  const diff = fingerprint([view.baseBranch, view.headBranch, content]);
  if (diff === shown.diff) return true;
  const response = await channel.slack.request("agents.conversations.setView", {
    channel_id: channel.slack.channelId,
    type: "diff",
    content,
    ...(view.baseBranch && { base_branch: view.baseBranch }),
    ...(view.headBranch && { head_branch: view.headBranch }),
  });
  if (!succeeded("agents.conversations.setView", response)) return false;
  shown.diff = diff;
  if (typeof response.view_id === "string") shown.diffViewId = response.view_id;
  return true;
}

// Cut at a file boundary, so the view never shows half a hunk.
function truncateDiff(diff: string): string | undefined {
  const bytes = new TextEncoder().encode(diff);
  if (bytes.length <= SLACK_DIFF_VIEW_MAX_BYTES) return diff;
  const head = new TextDecoder().decode(bytes.subarray(0, SLACK_DIFF_VIEW_MAX_BYTES));
  const cut = head.lastIndexOf("\ndiff --git ");
  return cut < 0 ? undefined : head.slice(0, cut + 1);
}

function surfaces(channel: SurfaceChannel): SlackCodeChannelSurfacesState {
  return (channel.state.codeChannelSurfaces ??= {});
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function succeeded(method: string, response: SlackApiResponse): boolean {
  if (response.ok === true) return true;
  log.warn(`Slack ${method} failed`, { error: String(response.error) });
  return false;
}
