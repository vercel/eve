import { signInEnding } from "#protocol/session-projection/reader.js";
import type { InteractionOutcome } from "#protocol/session-events/families/interaction.js";
import { truncatePlainText } from "#public/channels/slack/limits.js";
import {
  SIGN_IN_CANCEL_ACTION_ID,
  type SignInCancelTarget,
} from "#public/channels/slack/sign-in-cancel.js";
import { displayProperName } from "#protocol/session-projection/display-name.js";

export type { InteractionOutcome };

export function formatConnectionDisplayName(connectionName: string): string {
  return displayProperName(connectionName);
}

export function buildAuthRequiredPublicText(input: {
  readonly displayName: string;
  readonly recipientUserId: string | null;
}): string {
  if (input.recipientUserId === null) {
    return `${input.displayName} needs to be connected to continue, but the sign-in link couldn't be sent privately.`;
  }
  return `Paused: waiting for <@${input.recipientUserId}> to connect ${input.displayName}…`;
}

export function buildAuthCompletedText(input: {
  readonly displayName: string;
  readonly outcome: InteractionOutcome;
  readonly reason?: string;
}): string {
  if (input.outcome === "accepted") {
    return `:white_check_mark: ${input.displayName} connected`;
  }
  const ending = signInEnding(input.outcome);
  if (input.outcome === "declined" || ending === "cancelled") {
    return `${input.displayName} sign-in cancelled`;
  }
  const tail = input.reason !== undefined ? ` (${input.reason})` : "";
  return `:x: ${input.displayName} authorization ${ending}${tail}`;
}

interface AuthEphemeralPrompt {
  readonly displayName: string;
  readonly instructions?: string;
  readonly requestedInChannelId?: string;
  readonly url?: string;
  readonly userCode?: string;
}

export function buildAuthEphemeralBlocks(
  input: AuthEphemeralPrompt & {
    readonly cancel?: SignInCancelTarget;
  },
): unknown[] {
  const origin = hasText(input.requestedInChannelId)
    ? ` This is for your request in <#${input.requestedInChannelId}>.`
    : "";
  const intro =
    input.cancel === undefined
      ? `*Connect ${input.displayName}*\nTo continue, I need access to your ${input.displayName} account.${origin}`
      : `*Connect ${input.displayName}*\nI've paused until you connect your ${input.displayName} account or cancel.${origin}`;
  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: hasText(input.instructions) ? `${intro}\n\n${input.instructions}` : intro,
      },
    },
  ];
  const buttons = [
    ...(!hasText(input.url)
      ? []
      : [
          {
            type: "button",
            text: { type: "plain_text", text: truncatePlainText(`Connect ${input.displayName}`) },
            url: input.url,
            style: "primary",
          },
        ]),
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
  ];
  if (buttons.length > 0) blocks.push({ type: "actions", elements: buttons });
  if (hasText(input.userCode)) {
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

export function buildAuthEphemeralText(input: AuthEphemeralPrompt): string {
  const parts = [
    !hasText(input.url)
      ? `Connect your ${input.displayName} account to continue.`
      : `Connect your ${input.displayName} account to continue: ${input.url}`,
  ];
  if (hasText(input.instructions)) parts.push(input.instructions);
  if (hasText(input.userCode))
    parts.push(`If asked for a confirmation code, enter ${input.userCode}.`);
  return parts.join(" ");
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
