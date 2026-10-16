import type { Interaction, RequestSettlement } from "#channel/interaction-prompts.js";
import { postedIn, signInEndedText, type SignIn, type SignInSurface } from "#channel/sign-in.js";
import { surfaceEvents } from "#channel/surface.js";
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
import { displayProperName } from "#protocol/session-projection/display-name.js";
import {
  renderTeamsAuthorizationPrompt,
  renderTeamsAuthorizationStatus,
} from "#public/channels/teams/authorization.js";

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

async function showTeamsRequest(channel: TeamsHandlerChannel, request: Interaction): Promise<void> {
  const posted = await channel.thread.post(
    renderInteractionMessage(request, {
      adaptiveCardVersion: channel.adaptiveCardVersion,
      replyToActivityId: channel.teams.replyToActivityId,
    }),
  );
  if (!posted.id) return;
  const card = { activityId: posted.id, prompt: request.request.prompt };
  channel.state.pendingPromptCards = {
    ...channel.state.pendingPromptCards,
    [request.interactionId]:
      request.request.kind === "question"
        ? {
            ...card,
            options: (request.request.options ?? []).map(({ id, label }) => ({ id, label })),
          }
        : card,
  };
}

/** Retires a request's card with its answer; a pressed approval's names who pressed it. */
async function settleTeamsRequest(
  channel: TeamsHandlerChannel,
  settlement: RequestSettlement,
): Promise<void> {
  const { [settlement.interactionId]: card, ...rest } = channel.state.pendingPromptCards ?? {};
  if (card === undefined) return;
  const { kind, outcome, responder } = settlement;
  const pressed =
    kind === "approval" &&
    responder !== undefined &&
    (outcome === "accepted" || outcome === "declined");
  let label = resolvedPromptAnswer(settlement, card.options);
  if (pressed) {
    const account = channel.state.approvalResponderAccounts?.[responder.id];
    const actor = account?.name ?? account?.id;
    const decided = outcome === "accepted" ? "Approved" : "Cancelled";
    label = actor === undefined ? decided : `${decided} by ${actor}`;
  }
  await channel.thread.update(
    card.activityId,
    renderAnsweredInteractionMessage({ includeText: false, label, prompt: card.prompt }),
  );
  channel.state.pendingPromptCards = rest;
}

/**
 * A Teams conversation as a sign-in shows on it: a personal chat gets the card with the sign-in
 * link; a group or channel, which can't be messaged privately here, a link-free status.
 */
function teamsSignIns(channel: TeamsHandlerChannel): SignInSurface {
  return {
    private: channel.state.conversationType === "personal",
    postChallenge: async (signIn) =>
      (
        await channel.thread.post(
          renderTeamsAuthorizationPrompt(signIn, signInOptions(channel, signIn)),
        )
      ).id,
    post: async (text) => (await channel.thread.post({ text })).id,
    postStatus: async (signIn) =>
      (
        await channel.thread.post(
          renderTeamsAuthorizationStatus(signIn, signInOptions(channel, signIn)),
        )
      ).id,
    async edit(activityId, text) {
      await channel.thread.update(activityId, renderAnsweredInteractionMessage({ prompt: text }));
    },
    typing: () => channel.thread.startTyping(),
    posted: postedIn(channel.state, "pendingAuthActivityIds"),
  };
}

function signInOptions(channel: TeamsHandlerChannel, signIn: SignIn) {
  const responder =
    signIn.principalId === undefined
      ? undefined
      : channel.state.approvalResponderAccounts?.[signIn.principalId];
  const user = responder ?? (signIn.responseId === undefined ? channel.state.triggeringUser : null);
  return {
    adaptiveCardVersion: channel.adaptiveCardVersion,
    replyToActivityId: channel.teams.replyToActivityId,
    requester: user === null || user === undefined ? undefined : (user.name ?? user.id),
  };
}

/** Built-in Teams event handlers for typing, replies, HITL, auth cards, and terminal errors. */
export const defaultEvents: TeamsChannelEvents = surfaceEvents<TeamsHandlerChannel>({
  typing: (channel) => channel.thread.startTyping(),
  async post(channel, text) {
    for (const chunk of splitTeamsMessageText(text)) await channel.thread.post(chunk);
  },
  restart: "Teams conversation",
  requests: { show: showTeamsRequest, settle: settleTeamsRequest },
  signIns: teamsSignIns,
});

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
