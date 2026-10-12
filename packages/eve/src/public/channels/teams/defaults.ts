import {
  requestBatchOf,
  requestSettlementOf,
  type RequestBatch,
  type RequestSettlement,
} from "#channel/interaction-prompts.js";
import {
  postedIn,
  settleSignIn,
  showSignIn,
  signInEndedText,
  type SignIn,
  type SignInSurface,
} from "#channel/sign-in.js";
import { failureNotice, replyTextOf } from "#public/channels/reply.js";
import type { SessionAuthContext } from "#channel/types.js";

import { resolvedPromptAnswer } from "#channel/resolved-prompt.js";
import { splitTeamsMessageText, type TeamsMention } from "#public/channels/teams/api.js";
import {
  renderAnsweredInteractionMessage,
  renderInteractionMessage,
} from "#public/channels/teams/hitl.js";
import type { TeamsInvokeActivity, TeamsMessageActivity } from "#public/channels/teams/inbound.js";
import type {
  TeamsChannelEvents,
  TeamsContext,
  TeamsInboundResult,
} from "#public/channels/teams/teamsChannel.js";
import { displayProperName } from "#shared/display-name.js";
import { parseJsonObject } from "#shared/json.js";

/** Default auth projection for Teams message actors. */
export function defaultTeamsAuth(
  message: TeamsMessageActivity | TeamsInvokeActivity,
): SessionAuthContext {
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
  if (message.from.role === "bot" || message.from.id === message.recipient.id) return null;
  if (message.scope !== "personal" && !message.isBotMentioned) return null;
  await ctx.thread.startTyping();
  return { auth: defaultTeamsAuth(message) };
}

type TeamsHandlerChannel = Parameters<
  NonNullable<TeamsChannelEvents["turn.started"]>
>[1]["channel"];

async function showTeamsRequests(event: RequestBatch, channel: TeamsHandlerChannel): Promise<void> {
  for (const request of event.requests) {
    const posted = await channel.thread.post(
      renderInteractionMessage(request, {
        adaptiveCardVersion: channel.adaptiveCardVersion,
        replyToActivityId: channel.teams.replyToActivityId,
      }),
    );
    if (!posted.id) continue;
    const card = { activityId: posted.id, prompt: request.prompt };
    channel.state.pendingPromptCards = {
      ...channel.state.pendingPromptCards,
      [request.interactionId]:
        request.kind === "question"
          ? { ...card, options: (request.options ?? []).map(({ id, label }) => ({ id, label })) }
          : card,
    };
  }
}

/** A pressed approval retires its card with the person who pressed it. */
async function settleTeamsApproval(
  event: {
    readonly requestId: string;
    readonly outcome: "approved" | "cancelled";
    readonly responderPrincipalId: string;
  },
  channel: TeamsHandlerChannel,
): Promise<void> {
  const cards = channel.state.pendingPromptCards ?? {};
  const card = cards[event.requestId];
  if (card === undefined) return;
  const account = channel.state.approvalResponderAccounts?.[event.responderPrincipalId];
  const label = event.outcome === "approved" ? "Approved" : "Cancelled";
  const actor = account?.name ?? account?.id;
  await channel.thread.update(
    card.activityId,
    renderAnsweredInteractionMessage({
      includeText: false,
      label: actor === undefined ? label : `${label} by ${actor}`,
      prompt: card.prompt,
    }),
  );
  const next = { ...cards };
  delete next[event.requestId];
  channel.state.pendingPromptCards = next;
}

// A card that ends any other way (a typed answer, any question, or a withdrawal) retires here.
async function settleTeamsRequests(
  event: { readonly resolutions: readonly RequestSettlement[] },
  channel: TeamsHandlerChannel,
): Promise<void> {
  for (const resolution of event.resolutions) {
    const cards = channel.state.pendingPromptCards ?? {};
    const card = cards[resolution.interactionId];
    if (card === undefined) continue;
    await channel.thread.update(
      card.activityId,
      renderAnsweredInteractionMessage({
        includeText: false,
        label: resolvedPromptAnswer(resolution, card.options),
        prompt: card.prompt,
      }),
    );
    const { [resolution.interactionId]: _, ...rest } = cards;
    channel.state.pendingPromptCards = rest;
  }
}

/**
 * A Teams conversation as a sign-in shows on it: a personal chat gets the card with the sign-in
 * link; a group or channel, which can't be messaged privately here, a link-free status.
 */
function teamsSignIns(channel: TeamsHandlerChannel): SignInSurface {
  return {
    private: channel.state.conversationType === "personal",
    postChallenge: async (signIn) =>
      (await channel.thread.post(teamsSignInCard(signIn, channel))).id,
    post: async (text) => (await channel.thread.post({ text })).id,
    async edit(activityId, text) {
      await channel.thread.update(activityId, renderAnsweredInteractionMessage({ prompt: text }));
    },
    typing: () => channel.thread.startTyping(),
    posted: postedIn(channel.state, "pendingAuthActivityIds"),
  };
}

function teamsSignInCard(signIn: SignIn, channel: TeamsHandlerChannel) {
  const { displayName, instructions, url, userCode } = signIn;
  const codeHint = userCode
    ? `If ${displayName} asks for a confirmation code, enter ${userCode}.`
    : undefined;
  const text = [
    url
      ? `Authorization required for ${displayName}: ${url}`
      : `Authorization required for ${displayName}.`,
    instructions,
    codeHint,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    attachments: [
      {
        content: parseJsonObject({
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          actions: url
            ? [{ title: `Sign in with ${displayName}`, type: "Action.OpenUrl", url }]
            : [],
          body: [
            {
              text: `Authorization required for ${displayName}`,
              type: "TextBlock",
              weight: "Bolder",
              wrap: true,
            },
            ...[instructions, codeHint]
              .filter((line): line is string => Boolean(line))
              .map((line) => ({ text: line, type: "TextBlock", wrap: true })),
          ],
          type: "AdaptiveCard",
          version: channel.adaptiveCardVersion,
        }),
        contentType: "application/vnd.microsoft.card.adaptive",
      },
    ],
    text,
  };
}

/** Built-in Teams event handlers for typing, replies, HITL, auth cards, and terminal errors. */
export const defaultEvents: TeamsChannelEvents = {
  async "turn.started"(_event, { channel }) {
    await channel.thread.startTyping();
  },

  async "call.requested"(_event, { channel }) {
    await channel.thread.startTyping();
  },

  async "interaction.opened"(event, ctx) {
    const { data } = event;
    const { channel } = ctx;
    const batch = requestBatchOf(ctx.view, data);
    if (batch !== undefined) {
      await showTeamsRequests(batch, channel);
      return;
    }
    await showSignIn(ctx.view, data.interactionId, teamsSignIns(channel));
  },

  async "interaction.settled"({ data }, ctx) {
    const { channel } = ctx;
    await settleSignIn(ctx.view, data, teamsSignIns(channel));
    const resolution = requestSettlementOf(ctx.view, data);
    if (resolution === undefined) return;
    const pressed =
      resolution.kind === "approval" &&
      resolution.responder !== undefined &&
      (resolution.outcome === "accepted" || resolution.outcome === "declined");
    if (pressed && resolution.responder !== undefined) {
      await settleTeamsApproval(
        {
          outcome: resolution.outcome === "accepted" ? "approved" : "cancelled",
          requestId: resolution.interactionId,
          responderPrincipalId: resolution.responder.id,
        },
        channel,
      );
    }
    await settleTeamsRequests({ resolutions: [resolution] }, channel);
  },

  async "content.completed"({ data }, { channel }) {
    const text = replyTextOf(data);
    if (text === undefined) return;
    for (const chunk of splitTeamsMessageText(text)) {
      await channel.thread.post(chunk);
    }
  },

  async "session.ended"({ data }, { channel }) {
    const notice = failureNotice(data, { restart: "Teams conversation" });
    if (notice === undefined) return;
    await channel.thread.post(notice);
  },

  async "turn.settled"({ data }, { channel }) {
    const notice = failureNotice(data, "turn");
    if (notice === undefined) return;
    await channel.thread.post(notice);
  },
};

/** A connection name for the Teams auth card (`linear` → `Linear`). */
export function formatConnectionDisplayName(connectionName: string): string {
  return displayProperName(connectionName);
}

/** Builds final-state text for a completed connection authorization attempt. */
export const buildAuthCompletedText = signInEndedText;

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
