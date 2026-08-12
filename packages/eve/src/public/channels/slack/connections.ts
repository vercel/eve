/**
 * Slack rendering for `authorization.*` events.
 *
 * The framework emits these when a tool call needs the user to complete
 * an OAuth-style authorization flow (e.g. signing in to Linear). The
 * challenge is a credential: anyone in a shared thread could complete a
 * posted sign-in link and bind their own identity to the session. The
 * default handler therefore posts a link-free public status while
 * delivering the actual challenge as an ephemeral "Sign in with X"
 * message visible only to the triggering user.
 *
 * When no user can be targeted, or private delivery fails, the public
 * status still leaves the shared thread with safe progress feedback. The
 * matching `authorization.completed` handler edits that status post in place
 * to surface the outcome (`authorized` / `declined` / `failed` /
 * `timed-out`).
 */

import type { ConnectionAuthorizationOutcome } from "#protocol/message.js";
import { truncatePlainText, truncateSectionText } from "#public/channels/slack/limits.js";

export type { ConnectionAuthorizationOutcome };

/**
 * Title-cases a connection name (`linear` → `Linear`) for display. Empty
 * strings pass through unchanged so the renderer never emits an empty
 * label inside a sentence.
 */
export function formatConnectionDisplayName(connectionName: string): string {
  if (connectionName.length === 0) return connectionName;
  return connectionName.charAt(0).toUpperCase() + connectionName.slice(1);
}

/**
 * Public status text for an authorization challenge. Deliberately
 * link-free: it must stay safe to post in a shared thread. When the
 * channel cannot identify a triggering user (rare — schedule-initiated
 * sessions or events that lack actor metadata) the text drops the
 * "Connect with" call-to-action since there's no one to act on it.
 */
export function buildAuthRequiredPublicText(input: {
  readonly displayName: string;
  readonly hasUser: boolean;
}): string {
  if (!input.hasUser) {
    return `Authorization required for ${input.displayName} (no triggering user)`;
  }
  return `Connect with ${input.displayName} to continue`;
}

/**
 * Final-state markdown for the public status message. Edited in place by
 * `authorization.completed` so the thread sees resolution without
 * scrolling.
 */
export function buildAuthCompletedText(input: {
  readonly displayName: string;
  readonly outcome: ConnectionAuthorizationOutcome;
  readonly reason?: string;
}): string {
  if (input.outcome === "authorized") {
    return `:white_check_mark: ${input.displayName} connected`;
  }
  const tail = input.reason !== undefined ? ` (${input.reason})` : "";
  return `:x: ${input.displayName} authorization ${input.outcome}${tail}`;
}

/**
 * Block Kit blocks for the ephemeral authorization challenge. URL flows
 * render a "Sign in with X" button; URL-less flows can render instructions
 * and a device code without an action block. Slack ephemerals accept the
 * same block list shape as regular messages, so the helper returns blocks
 * directly.
 */
export function buildAuthEphemeralBlocks(input: {
  readonly displayName: string;
  readonly instructions?: string;
  readonly url?: string;
  readonly userCode?: string;
}): unknown[] {
  const blocks: unknown[] = [];
  if (input.instructions !== undefined && input.instructions.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncateSectionText(input.instructions) },
    });
  }
  if (input.userCode !== undefined && input.userCode.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateSectionText(`Use code \`${input.userCode}\` when prompted.`),
      },
    });
  }
  if (input.url !== undefined) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: truncatePlainText(`Sign in with ${input.displayName}`),
          },
          url: input.url,
          style: "primary",
        },
      ],
    });
  }
  return blocks;
}
