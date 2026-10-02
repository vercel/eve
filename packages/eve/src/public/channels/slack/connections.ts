/**
 * Slack rendering for `authorization.*` events.
 *
 * The framework emits these when a tool call needs the user to complete
 * an OAuth-style authorization flow (e.g. signing in to Linear). The
 * challenge is a credential: anyone in a shared thread could complete a
 * posted sign-in link and bind their own identity to the session. The
 * default handler therefore posts a link-free public status while
 * delivering the actual challenge as an ephemeral "Sign in"
 * message visible only to the Slack user behind the event's `principalId`.
 *
 * When no user can be targeted (no Slack user for the principal, no challenge
 * URL, or the ephemeral delivery fails), the public status still leaves
 * the shared thread with safe progress feedback. The matching
 * `authorization.completed` handler edits that status post in place to
 * surface the outcome (`authorized` / `declined` / `failed` /
 * `timed-out`).
 */
import type { ConnectionAuthorizationOutcome } from "#protocol/message.js";
import { truncatePlainText } from "#public/channels/slack/limits.js";
import {
  SIGN_IN_CANCEL_ACTION_ID,
  type SignInCancelTarget,
} from "#public/channels/slack/sign-in-cancel.js";
import { displayProperName } from "#shared/display-name.js";

export type { ConnectionAuthorizationOutcome };

/** A connection name for display (`linear` → `Linear`, `my_crm` → `My crm`). */
export function formatConnectionDisplayName(connectionName: string): string {
  return displayProperName(connectionName);
}

/**
 * Public status text for an authorization challenge. Deliberately
 * link-free: it must stay safe to post in a shared thread. When the
 * principal has no Slack user in this thread (schedule-initiated sessions,
 * or principals never seen here) the text drops the "Connect with"
 * call-to-action since no one received the link.
 */
export function buildAuthRequiredPublicText(input: {
  readonly displayName: string;
  readonly recipientUserId: string | null;
}): string {
  if (input.recipientUserId === null) {
    return `${input.displayName} needs to be connected to continue, but the sign-in link couldn't be sent privately.`;
  }
  return `Paused: waiting for <@${input.recipientUserId}> to connect ${input.displayName}…`;
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
  if (input.outcome === "declined") {
    return `${input.displayName} sign-in cancelled`;
  }
  const tail = input.reason !== undefined ? ` (${input.reason})` : "";
  return `:x: ${input.displayName} authorization ${input.outcome}${tail}`;
}

/**
 * Block Kit blocks for the private sign-in prompt. It names the service and
 * why it is asking before the button, because the user may not remember which
 * request needed it. A device-code flow's `userCode` is a fallback the
 * provider shows only sometimes, so it is a quiet hint below the button.
 */
export function buildAuthEphemeralBlocks(input: {
  /** Lets the person cancel the held turn instead of connecting. */
  readonly cancel?: SignInCancelTarget;
  readonly displayName: string;
  readonly url: string;
  readonly userCode?: string;
}): unknown[] {
  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          input.cancel === undefined
            ? `*Connect ${input.displayName}*\nTo continue, I need access to your ${input.displayName} account. Only you can see this message.`
            : `*Connect ${input.displayName}*\nI've paused until you connect your ${input.displayName} account or cancel. Only you can see this message.`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: truncatePlainText(`Connect ${input.displayName}`) },
          url: input.url,
          style: "primary",
        },
        ...(input.cancel === undefined
          ? []
          : [
              {
                type: "button",
                action_id: SIGN_IN_CANCEL_ACTION_ID,
                text: { type: "plain_text", text: "Cancel" },
                value: JSON.stringify(input.cancel),
              },
            ]),
      ],
    },
  ];
  if (input.userCode !== undefined && input.userCode.length > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `If ${input.displayName} asks for a confirmation code, enter \`${input.userCode}\`.`,
        },
      ],
    });
  }
  return blocks;
}

/** Notification text for the private sign-in prompt, for clients that show no blocks. */
export function buildAuthEphemeralText(input: {
  readonly displayName: string;
  readonly url: string;
  readonly userCode?: string;
}): string {
  const code =
    input.userCode !== undefined && input.userCode.length > 0
      ? ` If asked for a confirmation code, enter ${input.userCode}.`
      : "";
  return `Connect your ${input.displayName} account to continue: ${input.url}${code}`;
}
