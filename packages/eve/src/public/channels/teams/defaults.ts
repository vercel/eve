import type { SessionAuthContext } from "#channel/types.js";

import { extractErrorId, formatErrorHint } from "#internal/logging.js";
import type { ConnectionAuthorizationOutcome } from "#protocol/message.js";
import { splitTeamsMessageText, type TeamsMention } from "#public/channels/teams/api.js";
import {
  renderAnsweredInputRequestMessage,
  renderInputRequestMessage,
} from "#public/channels/teams/hitl.js";
import type { TeamsMessageActivity } from "#public/channels/teams/inbound.js";
import type {
  TeamsChannelEvents,
  TeamsContext,
  TeamsInboundResult,
} from "#public/channels/teams/teamsChannel.js";
import { parseJsonObject } from "#shared/json.js";

/** Default auth projection for Teams message actors. */
export function defaultTeamsAuth(message: TeamsMessageActivity): SessionAuthContext {
  const tenantId = message.tenantId;
  const attributes: Record<string, string> = {
    activity_id: message.id,
    conversation_id: message.conversation.id,
    scope: message.scope,
    user_id: message.from.id,
  };
  if (message.from.name !== undefined) attributes.user_name = message.from.name;
  if (message.from.aadObjectId !== undefined) attributes.aad_object_id = message.from.aadObjectId;
  if (tenantId !== undefined) attributes.tenant_id = tenantId;
  if (message.teamId !== undefined) attributes.team_id = message.teamId;
  if (message.teamsChannelId !== undefined) attributes.channel_id = message.teamsChannelId;

  const principalId = tenantId
    ? `teams:${tenantId}:${message.from.id}`
    : `teams:${message.from.id}`;

  return {
    attributes,
    authenticator: "teams-activity",
    issuer: tenantId ? `teams:${tenantId}` : "teams",
    principalId,
    principalType: message.from.role === "bot" ? "service" : "user",
    subject: message.from.aadObjectId,
  };
}

/** Default message hook: mention-gated dispatch with Teams user auth. */
export async function defaultOnMessage(
  ctx: TeamsContext,
  message: TeamsMessageActivity,
): Promise<TeamsInboundResult> {
  if (message.scope !== "personal" && !message.isBotMentioned) return null;
  await ctx.thread.startTyping();
  return { auth: defaultTeamsAuth(message) };
}

/** Built-in Teams event handlers for typing, replies, HITL, auth cards, and terminal errors. */
export const defaultEvents: TeamsChannelEvents = {
  async "turn.started"(_event, channel, _ctx) {
    await channel.thread.startTyping();
  },

  async "actions.requested"(_event, channel, _ctx) {
    await channel.thread.startTyping();
  },

  async "input.requested"(event, channel, _ctx) {
    for (const request of event.requests) {
      await channel.thread.post(
        renderInputRequestMessage(request, {
          adaptiveCardVersion: channel.adaptiveCardVersion,
        }),
      );
    }
  },

  async "message.completed"(event, channel, _ctx) {
    if (event.finishReason === "tool-calls" || !event.message) return;
    for (const chunk of splitTeamsMessageText(event.message)) {
      await channel.thread.post(chunk);
    }
  },

  async "session.failed"(event, channel) {
    const hint = formatErrorHint(event);
    const errorId = extractErrorId(event.details);
    await channel.thread.post(
      [
        `This session could not recover from an error${hint}.`,
        "",
        "Start a new Teams conversation to continue.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n"),
    );
  },

  async "turn.failed"(event, channel, _ctx) {
    const hint = formatErrorHint(event);
    const errorId = extractErrorId(event.details);
    await channel.thread.post(
      [
        `I hit an error while handling your request${hint}.`,
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n"),
    );
  },

  async "authorization.required"(event, channel, _ctx) {
    const displayName = event.authorization?.displayName ?? formatConnectionDisplayName(event.name);
    const url = event.authorization?.url;
    const text = url
      ? `Authorization required for ${displayName}: ${url}`
      : `Authorization required for ${displayName}.`;
    const posted = await channel.thread.post({
      attachments: [
        {
          content: parseJsonObject({
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            actions: url
              ? [
                  {
                    title: `Sign in with ${displayName}`,
                    type: "Action.OpenUrl",
                    url,
                  },
                ]
              : [],
            body: [
              {
                text: `Authorization required for ${displayName}`,
                type: "TextBlock",
                weight: "Bolder",
                wrap: true,
              },
              {
                text: channel.state.triggeringUser
                  ? `Requested by ${channel.state.triggeringUser.name ?? channel.state.triggeringUser.id}.`
                  : "No triggering user is available for a private prompt.",
                type: "TextBlock",
                wrap: true,
              },
            ],
            type: "AdaptiveCard",
            version: channel.adaptiveCardVersion,
          }),
          contentType: "application/vnd.microsoft.card.adaptive",
        },
      ],
      text,
    });
    if (posted.id) {
      channel.state.pendingAuthActivityId = posted.id;
    }
  },

  async "authorization.completed"(event, channel, _ctx) {
    const activityId = channel.state.pendingAuthActivityId;
    if (!activityId) return;
    const displayName = event.authorization?.displayName ?? formatConnectionDisplayName(event.name);
    const text = buildAuthCompletedText({
      displayName,
      outcome: event.outcome as ConnectionAuthorizationOutcome,
      reason: event.reason,
    });
    await channel.thread.update(activityId, renderAnsweredInputRequestMessage({ prompt: text }));
    channel.state.pendingAuthActivityId = null;
  },
};

/** Capitalizes the first character of a connection name for Teams auth card display (e.g. "linear" -> "Linear"). */
export function formatConnectionDisplayName(connectionName: string): string {
  if (connectionName.length === 0) return connectionName;
  return connectionName.charAt(0).toUpperCase() + connectionName.slice(1);
}

/** Builds final-state text for a completed connection authorization attempt. */
export function buildAuthCompletedText(input: {
  readonly displayName: string;
  readonly outcome: ConnectionAuthorizationOutcome;
  readonly reason?: string;
}): string {
  if (input.outcome === "authorized") return `${input.displayName} connected.`;
  const tail = input.reason !== undefined ? ` (${input.reason})` : "";
  return `${input.displayName} authorization ${input.outcome}${tail}.`;
}

/** Builds a Teams mention entity and matching text for one channel account. */
export function teamsMentionUser(user: {
  readonly id: string;
  readonly name?: string;
}): TeamsMention {
  const label = user.name ?? user.id;
  return {
    mentioned: { id: user.id, name: user.name },
    text: `<at>${label}</at>`,
    type: "mention",
  };
}
