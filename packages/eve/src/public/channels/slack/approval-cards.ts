/**
 * eve's default Slack rendering for human-input requests: posting approval
 * and question controls, and retiring an approval's messages once it resolves.
 */

import type {
  RefusedAnswer,
  RequestBatch,
  RequestSettlement,
} from "#channel/interaction-prompts.js";
import { createLogger, logError } from "#internal/logging.js";
import {
  slackUserIdForPrincipal,
  slackUserIdFromAuthContext,
} from "#public/channels/slack/auth.js";
import {
  buildAnsweredBlocks,
  decodeHitlActionId,
  renderInputRequestPostParts,
  type SlackInputRequestPostPart,
} from "#public/channels/slack/hitl.js";
import {
  SLACK_MAX_BLOCKS_PER_MESSAGE,
  truncateMessageText,
} from "#public/channels/slack/limits.js";
import { deliverPrivateInputRequest } from "#public/channels/slack/private-approval-delivery.js";
import type {
  SlackApprovalChannelResolver,
  SlackChannelInternalEvents,
  SlackChannelState,
  SlackEventContext,
  SlackPendingApprovalCard,
} from "#public/channels/slack/slackChannel.js";
import type { InputRequest } from "#shared/input.js";

const log = createLogger("slack.defaults");

/**
 * Default `input.requested` handler — renders each pending HITL
 * request as Slack `block_actions`. Buttons by default; radio for
 * ≤6-option select requests; static_select for >6-option select
 * requests. Batches split into multiple posts when they would exceed
 * Slack's 50-block message cap.
 */
export function defaultInputRequestedHandler(
  approvalChannel?: SlackApprovalChannelResolver,
): (
  data: RequestBatch,
  channel: SlackEventContext,
  ctx: Parameters<NonNullable<SlackChannelInternalEvents["interaction.opened"]>>[2],
) => Promise<void> {
  return async (data, channel, ctx) => {
    const directMessageRequests: InputRequest[] = [];
    const threadRequests: InputRequest[] = [];
    for (const request of data.requests) {
      const destination =
        approvalChannel === undefined ? "thread" : await approvalChannel(request, ctx);
      (destination === "direct-message" ? directMessageRequests : threadRequests).push(request);
    }

    await postPublicInputRequests(threadRequests, channel);
    for (const request of directMessageRequests) {
      const reviewer =
        slackUserIdFromAuthContext(ctx.session.auth.current) ?? channel.state.triggeringUserId;
      if (!reviewer) {
        log.warn("direct-message input request not delivered because no reviewer was resolved", {
          requestId: request.requestId,
          sessionId: ctx.session.id,
        });
        continue;
      }
      const card = await deliverPrivateInputRequest({
        previewMessageTs: channel.state.triggeringMessageTs ?? channel.slack.threadTs,
        request,
        reviewer,
        slack: channel.slack,
      });
      recordApprovalCards(channel.state, [request], card);
      try {
        const announcement = await channel.thread.post(
          `Waiting on ${request.kind === "tool-approval" ? "approval" : "a response"} from <@${reviewer}>…`,
        );
        if (announcement.id) {
          recordApprovalCards(channel.state, [request], {
            ...card,
            announcementTs: announcement.id,
          });
        }
      } catch (error) {
        logError(log, "failed to announce private input request", error, {
          requestId: request.requestId,
          sessionId: ctx.session.id,
        });
      }
    }
  };
}

async function postPublicInputRequests(
  requests: readonly InputRequest[],
  channel: SlackEventContext,
): Promise<void> {
  const detailsByRequest = new Map<string, string>();
  for (const post of buildInputRequestPosts(requests)) {
    const message = await channel.thread.post({ blocks: post.blocks, text: post.text });
    if (post.kind === "details") {
      if (message.id) {
        for (const request of post.requests) detailsByRequest.set(request.requestId, message.id);
      }
      continue;
    }
    for (const request of post.requests) {
      const detailsMessageTs = detailsByRequest.get(request.requestId);
      recordApprovalCards(channel.state, [request], {
        detailsMessageTs,
        messageBlocks: post.blocks,
        messageTs: message.id,
      });
    }
  }
}

function recordApprovalCards(
  state: SlackChannelState,
  requests: readonly InputRequest[],
  card: SlackPendingApprovalCard,
): void {
  if (!card.messageTs) return;
  const cards = { ...state.pendingApprovalCards };
  for (const request of requests) {
    if (request.kind === "tool-approval") cards[request.requestId] = card;
  }
  state.pendingApprovalCards = cards;
}

/**
 * Retires an approval's Slack messages once it resolves, however it resolved:
 * the card loses its buttons, the tool-input details post is deleted when no
 * other pending approval shares it, and a direct-message announcement in the
 * thread reports the outcome. Slack failures are logged, and the card is
 * forgotten either way so a failed update is never retried forever.
 */
async function settleApprovalCard(
  channel: SlackEventContext,
  requestId: string,
  answer: { readonly announcement: string; readonly label: string; readonly userId?: string },
): Promise<void> {
  const cards = channel.state.pendingApprovalCards ?? {};
  const card = cards[requestId];
  if (card === undefined) return;
  const next = { ...cards };
  delete next[requestId];
  channel.state.pendingApprovalCards = next;
  const messageChannelId = card.messageChannelId ?? channel.state.channelId;
  if (messageChannelId === null) return;

  const blocks = card.messageBlocks.flatMap((block) => {
    if (!blockContainsRequestAction(block, requestId)) return [block];
    if (typeof block !== "object" || block === null) return [];
    const candidate = block as Record<string, unknown>;
    if (candidate.type !== "card") {
      return buildAnsweredBlocks({
        answerLabel: answer.label,
        promptBlocks: [],
        userId: answer.userId,
      });
    }
    const { actions: _actions, subtext: _subtext, ...withoutActions } = candidate;
    return buildAnsweredBlocks({
      answerLabel: answer.label,
      promptBlocks: [withoutActions],
      userId: answer.userId,
    });
  });
  for (const [otherId, pendingCard] of Object.entries(next)) {
    if (pendingCard.messageTs === card.messageTs) {
      next[otherId] = { ...pendingCard, messageBlocks: blocks };
    }
  }
  await settleRequest(channel, "chat.update", requestId, {
    blocks,
    channel: messageChannelId,
    text: `Answered: ${answer.label}`,
    ts: card.messageTs,
  });

  const details = card.detailsMessageTs;
  if (details !== undefined && !Object.values(next).some((c) => c.detailsMessageTs === details)) {
    await settleRequest(channel, "chat.delete", requestId, {
      channel: messageChannelId,
      ts: details,
    });
  }
  if (card.announcementTs !== undefined && channel.state.channelId !== null) {
    await settleRequest(channel, "chat.update", requestId, {
      channel: channel.state.channelId,
      text: answer.announcement,
      ts: card.announcementTs,
    });
  }
}

async function settleRequest(
  channel: SlackEventContext,
  operation: "chat.delete" | "chat.update",
  requestId: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    const response = await channel.slack.request(operation, body);
    if (response.ok !== true) {
      log.warn("failed to retire approval message", {
        error: response.error,
        operation,
        requestId,
      });
    }
  } catch (error) {
    logError(log, "failed to retire approval message", error, { operation, requestId });
  }
}

/**
 * Groups HITL requests into `chat.postMessage` payloads that stay under
 * Slack's block-count cap. Tool input details are posted before interactive
 * approval controls so Slack's callback body cannot grow with the input.
 */
function buildInputRequestPosts(requests: readonly InputRequest[]): Array<{
  blocks: unknown[];
  kind: "controls" | "details";
  requests: InputRequest[];
  text: string;
}> {
  const details: Array<SlackInputRequestPostPart & { readonly request: InputRequest }> = [];
  const controls: Array<SlackInputRequestPostPart & { readonly request: InputRequest }> = [];
  for (const request of requests) {
    const parts = renderInputRequestPostParts(request);
    if (parts.details) details.push({ ...parts.details, request });
    controls.push({ ...parts.controls, request });
  }

  return [
    ...groupInputRequestPostParts(details).map((post) => ({ ...post, kind: "details" as const })),
    ...groupInputRequestPostParts(controls).map((post) => ({ ...post, kind: "controls" as const })),
  ];
}

function groupInputRequestPostParts(
  parts: readonly (SlackInputRequestPostPart & { readonly request: InputRequest })[],
): Array<{ blocks: unknown[]; requests: InputRequest[]; text: string }> {
  const groups: Array<{ blocks: unknown[]; fallbacks: string[]; requests: InputRequest[] }> = [];
  for (const part of parts) {
    const current = groups.at(-1);
    if (current && current.blocks.length + part.blocks.length <= SLACK_MAX_BLOCKS_PER_MESSAGE) {
      current.blocks.push(...part.blocks);
      current.fallbacks.push(part.text);
      current.requests.push(part.request);
    } else {
      groups.push({ blocks: [...part.blocks], fallbacks: [part.text], requests: [part.request] });
    }
  }
  return groups.map((group) => ({
    blocks: group.blocks,
    requests: group.requests,
    text: truncateMessageText(group.fallbacks.join("\n")),
  }));
}

function blockContainsRequestAction(block: unknown, requestId: string): boolean {
  if (typeof block !== "object" || block === null) return false;
  const candidate = block as { actions?: unknown; elements?: unknown };
  return [candidate.actions, candidate.elements].some(
    (entries) =>
      Array.isArray(entries) &&
      entries.some((entry) => {
        if (typeof entry !== "object" || entry === null) return false;
        const actionId = (entry as { action_id?: unknown }).action_id;
        return (
          typeof actionId === "string" && decodeHitlActionId(actionId)?.requestId === requestId
        );
      }),
  );
}

/**
 * A responder an approval's policy or check refused hears why privately. A pending answer gets
 * no notice: an ephemeral cannot be removed once the approval settles, and the card itself
 * reports the outcome moments later.
 */
export async function notifyRefusedResponder(
  refused: RefusedAnswer,
  channel: SlackEventContext,
): Promise<void> {
  const userId = slackUserIdForPrincipal(channel.state, refused.responder?.id);
  if (userId === undefined) return;
  await channel.thread.postEphemeral(
    userId,
    refused.reason ?? "We couldn’t verify your response. Please try again.",
  );
}

/**
 * Retires an approval's card: with the person whose press decided it, or as no longer needed
 * when it ended any other way (the user replied instead, or it was withdrawn).
 */
export async function settleApproval(
  resolution: RequestSettlement,
  channel: SlackEventContext,
): Promise<void> {
  if (resolution.kind !== "tool-approval") return;
  const decided = resolution.outcome === "approved" || resolution.outcome === "denied";
  if (!decided) {
    await settleApprovalCard(channel, resolution.requestId, {
      announcement: "This approval is no longer needed.",
      label: "No longer needed",
    });
    return;
  }
  const approved = resolution.outcome === "approved";
  const userId = slackUserIdForPrincipal(channel.state, resolution.responder?.id);
  const by = userId === undefined ? "" : ` by <@${userId}>`;
  await settleApprovalCard(channel, resolution.requestId, {
    announcement: `${approved ? "Approved" : "Cancelled"}${by}.`,
    label: approved ? "Approve" : "Cancel",
    userId,
  });
}
