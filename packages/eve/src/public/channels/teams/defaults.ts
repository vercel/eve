import {
  requestBatchOf,
  requestSettlementOf,
  signInPromptOf,
  signInSettlementOf,
  type RequestBatch,
  type RequestSettlement,
  type SignInPrompt,
  type SignInSettlement,
} from "#channel/interaction-prompts.js";
import { errorHintOf, replyTextOf } from "#public/channels/reply.js";
import type { SessionAuthContext } from "#channel/types.js";

import { resolvedPromptAnswer } from "#channel/resolved-prompt.js";
import { formatErrorHint } from "#internal/logging.js";
import type { ConnectionAuthorizationOutcome } from "#protocol/message.js";
import { splitTeamsMessageText, type TeamsMention } from "#public/channels/teams/api.js";
import {
  renderAnsweredInputRequestMessage,
  renderInputRequestMessage,
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
      renderInputRequestMessage(request, {
        adaptiveCardVersion: channel.adaptiveCardVersion,
        replyToActivityId: channel.teams.replyToActivityId,
      }),
    );
    if (!posted.id) continue;
    const card = { activityId: posted.id, prompt: request.prompt };
    channel.state.pendingPromptCards = {
      ...channel.state.pendingPromptCards,
      [request.requestId]:
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
    renderAnsweredInputRequestMessage({
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
    const card = cards[resolution.requestId];
    if (card === undefined) continue;
    await channel.thread.update(
      card.activityId,
      renderAnsweredInputRequestMessage({
        includeText: false,
        label: resolvedPromptAnswer(resolution, card.options),
        prompt: card.prompt,
      }),
    );
    const { [resolution.requestId]: _, ...rest } = cards;
    channel.state.pendingPromptCards = rest;
  }
}

async function showTeamsSignIn(event: SignInPrompt, channel: TeamsHandlerChannel): Promise<void> {
  const displayName = event.authorization?.displayName ?? formatConnectionDisplayName(event.name);
  const url = event.authorization?.url;
  const instructions = event.authorization?.instructions;
  const userCode = event.authorization?.userCode;
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
  });
  if (posted.id) {
    channel.state.pendingAuthActivityId = posted.id;
  }
}

async function settleTeamsSignIn(
  event: SignInSettlement,
  channel: TeamsHandlerChannel,
): Promise<void> {
  if (event.outcome === "authorized") {
    await channel.thread.startTyping();
  }

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
    const prompt = signInPromptOf(data, event.scope);
    if (prompt !== undefined) await showTeamsSignIn(prompt, channel);
  },

  async "interaction.settled"({ data }, ctx) {
    const { channel } = ctx;
    const signIn = signInSettlementOf(ctx.view, data);
    if (signIn !== undefined) {
      await settleTeamsSignIn(signIn, channel);
      return;
    }
    const resolution = requestSettlementOf(ctx.view, data);
    if (resolution === undefined) return;
    const pressed =
      resolution.kind === "tool-approval" &&
      resolution.responder !== undefined &&
      (resolution.outcome === "approved" || resolution.outcome === "denied");
    if (pressed && resolution.responder !== undefined) {
      await settleTeamsApproval(
        {
          outcome: resolution.outcome === "approved" ? "approved" : "cancelled",
          requestId: resolution.requestId,
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
    if (data.outcome !== "failed") return;
    const hint = formatErrorHint(errorHintOf(data.error));
    const errorId = data.error?.id;
    await channel.thread.post(
      [
        `This session could not recover from an error${hint}.`,
        "",
        "Start a new Teams conversation to continue.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n"),
    );
  },

  async "turn.settled"({ data }, { channel }) {
    if (data.outcome !== "failed") return;
    const hint = formatErrorHint(errorHintOf(data.error));
    const errorId = data.error?.id;
    await channel.thread.post(
      [
        `I hit an error while handling your request${hint}.`,
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n"),
    );
  },
};

/** A connection name for the Teams auth card (`linear` → `Linear`). */
export function formatConnectionDisplayName(connectionName: string): string {
  return displayProperName(connectionName);
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
