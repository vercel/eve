/**
 * eve's Slack cards for approvals, questions, and budget prompts: a commit's requests post as one
 * batch, and each card updates as its request is answered and settles. Renderers choose the
 * blocks through `interactionCard`; this module owns routing, batching, and the messages.
 */

import {
  interaction as interactionOf,
  type Interaction,
  type RefusedAnswer,
  type RequestBatch,
  responderOf,
} from "#channel/interaction-prompts.js";
import { createLogger, logError } from "#internal/logging.js";
import { sessionTables } from "#protocol/session-projection/session-view.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import type { ChannelEventContext } from "#public/definitions/channel.js";
import {
  slackUserIdForPrincipal,
  slackUserIdFromAuthContext,
} from "#public/channels/slack/auth.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import type { SlackHitlRoute } from "#public/channels/slack/hitl.js";
import {
  SLACK_MAX_BLOCKS_PER_MESSAGE,
  truncateMessageText,
} from "#public/channels/slack/limits.js";
import { deliverPrivateInteraction } from "#public/channels/slack/private-approval-delivery.js";
import type {
  SlackInteractionCard,
  SlackInteractionCardChain,
  SlackInteractionMessage,
} from "#public/channels/slack/renderers.js";
import {
  type RenderedRequestCard,
  renderRequestCard,
  sameJson,
} from "#public/channels/slack/request-card-render.js";
import type {
  SlackApprovalChannel,
  SlackApprovalChannelResolver,
  SlackChannelState,
  SlackEventContext,
  SlackInteractionCardRecord,
  SlackInteractionCardRequest,
} from "#public/channels/slack/slackChannel.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";

const log = createLogger("slack.request-cards");

type RequestCardContext = ChannelEventContext<SlackEventContext>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Posts a commit's requests: each `approvalChannel` sends to the thread joins one batch, details
 * first, then controls, grouped under Slack's 50-block cap; each sent to a DM posts there alone.
 */
export async function postRequestCards(
  batch: RequestBatch,
  ctx: RequestCardContext,
  chain: SlackInteractionCardChain,
  approvalChannel: SlackApprovalChannelResolver | undefined,
): Promise<void> {
  const directMessageRequests: Interaction[] = [];
  const threadRequests: Interaction[] = [];
  for (const request of batch.requests) {
    const destination =
      approvalChannel === undefined ? "thread" : await approvalChannel(request, ctx);
    (destination === "direct-message" ? directMessageRequests : threadRequests).push(request);
  }
  await postThreadCards(threadRequests, ctx, chain);
  for (const request of directMessageRequests) await postDirectMessageCard(request, ctx, chain);
}

interface CardEntry extends RenderedRequestCard {
  readonly interactionId: string;
}

interface CardPart {
  readonly interactionId: string;
  readonly message: SlackInteractionMessage;
}

async function postThreadCards(
  requests: readonly Interaction[],
  ctx: RequestCardContext,
  chain: SlackInteractionCardChain,
): Promise<void> {
  const { channel } = ctx;
  if (requests.length === 0) return;
  const entries = requests.map((request): CardEntry => ({
    interactionId: request.interactionId,
    ...renderRequestCard(chain, cardOf(request, "thread", ctx)),
  }));
  const post = async (message: SlackInteractionMessage) =>
    (await channel.thread.post({ blocks: [...message.blocks], text: message.text })).id;

  const detailsTs = new Map<string, string>();
  for (const posted of await postGroups(entries, "details", post)) {
    for (const part of posted.parts) detailsTs.set(part.interactionId, posted.ts);
  }
  const channelId = channel.state.channelId;
  for (const posted of await postGroups(entries, "controls", post)) {
    if (channelId === null) continue;
    remember(channel.state, {
      channelId,
      destination: "thread",
      requests: posted.parts.map(({ interactionId, message }) =>
        cardRequest(interactionId, message.blocks, detailsTs.get(interactionId)),
      ),
      ts: posted.ts,
    });
  }
}

/**
 * Posts each group of `kind` messages. A group Slack rejects posts again with each request's
 * default, regrouped, since the defaults can need more blocks than the rendered messages.
 */
async function postGroups(
  entries: readonly CardEntry[],
  kind: "controls" | "details",
  post: (message: SlackInteractionMessage) => Promise<string>,
): Promise<{ readonly parts: readonly CardPart[]; readonly ts: string }[]> {
  const posted: { parts: readonly CardPart[]; ts: string }[] = [];
  const sendGroup = async (parts: readonly CardPart[]) => {
    const ts = await post(joinParts(parts));
    if (ts) posted.push({ parts, ts });
  };
  for (const group of groupParts(entries, (entry) => entry.parts[kind])) {
    const members = entries.filter((entry) =>
      group.some((part) => part.interactionId === entry.interactionId),
    );
    try {
      await sendGroup(group);
    } catch (error) {
      if (members.every((entry) => sameJson(entry.parts[kind], entry.fallback[kind]))) throw error;
      logError(log, "Slack rejected rendered input requests; posting eve's defaults", error);
      for (const retry of groupParts(members, (entry) => entry.fallback[kind])) {
        await sendGroup(retry);
      }
    }
  }
  return posted;
}

function groupParts(
  entries: readonly CardEntry[],
  messageOf: (entry: CardEntry) => SlackInteractionMessage | undefined,
): CardPart[][] {
  const groups: CardPart[][] = [];
  let blocks = 0;
  for (const entry of entries) {
    const message = messageOf(entry);
    if (message === undefined) continue;
    const current = groups.at(-1);
    if (current && blocks + message.blocks.length <= SLACK_MAX_BLOCKS_PER_MESSAGE) {
      current.push({ interactionId: entry.interactionId, message });
      blocks += message.blocks.length;
    } else {
      groups.push([{ interactionId: entry.interactionId, message }]);
      blocks = message.blocks.length;
    }
  }
  return groups;
}

function joinParts(parts: readonly CardPart[]): SlackInteractionMessage {
  return {
    blocks: parts.flatMap((part) => part.message.blocks),
    text: truncateMessageText(parts.map((part) => part.message.text).join("\n")),
  };
}

async function postDirectMessageCard(
  request: Interaction,
  ctx: RequestCardContext,
  chain: SlackInteractionCardChain,
): Promise<void> {
  const { channel } = ctx;
  const reviewer =
    slackUserIdFromAuthContext(ctx.session.auth.current) ?? channel.state.triggeringUserId;
  if (!reviewer) {
    log.warn("direct-message input request not delivered because no reviewer was resolved", {
      requestId: request.interactionId,
      sessionId: ctx.session.id,
    });
    return;
  }
  const route: SlackHitlRoute = {
    channelId: channel.slack.channelId,
    threadTs: channel.slack.threadTs,
  };
  const delivery = await deliverPrivateInteraction({
    card: renderRequestCard(chain, cardOf(request, "direct-message", ctx), route),
    previewMessageTs: channel.state.triggeringMessageTs ?? channel.slack.threadTs,
    reviewer,
    slack: channel.slack,
  });
  const record: SlackInteractionCardRecord = {
    channelId: delivery.channelId,
    destination: "direct-message",
    requests: [cardRequest(request.interactionId, delivery.blocks, delivery.detailsTs)],
    route,
    ts: delivery.ts,
  };
  remember(channel.state, record);
  try {
    const announcement = await channel.thread.post(
      `Waiting on ${request.request.kind === "approval" ? "approval" : "a response"} from <@${reviewer}>…`,
    );
    if (announcement.id)
      replace(channel.state, record, { ...record, announcementTs: announcement.id });
  } catch (error) {
    logError(log, "failed to announce private input request", error, {
      requestId: request.interactionId,
      sessionId: ctx.session.id,
    });
  }
}

/**
 * Brings one request's card in line with the session: renders it again, updates its message
 * when the blocks changed, and once it settles, deletes its details message when no open request
 * shares it and reports the outcome in a DM request's thread announcement. A card whose requests
 * have all settled is forgotten, even if a Slack call failed, so a failure is never retried
 * forever.
 */
export async function refreshRequestCard(
  interactionId: string,
  ctx: RequestCardContext,
  chain: SlackInteractionCardChain,
): Promise<void> {
  const { channel } = ctx;
  const record = channel.state.interactionCards?.find((candidate) =>
    candidate.requests.some((request) => request.interactionId === interactionId),
  );
  const tables = sessionTables(ctx.view);
  const interaction = interactionOf(tables, interactionId);
  if (record === undefined || interaction === undefined) return;

  const card = cardOf(interaction, record.destination, ctx);
  const updated = await updateCard(
    channel,
    record,
    interactionId,
    renderRequestCard(chain, card, record.route),
  );
  let current = updated ?? record;
  if (interaction.status === "settled") {
    current = await retireDetails(channel, tables, current, interactionId);
    if (current.announcementTs !== undefined && channel.state.channelId !== null) {
      await callSlack(channel, "chat.update", interactionId, {
        channel: channel.state.channelId,
        text: announcementOf(interaction, card.answeredBy),
        ts: current.announcementTs,
      });
    }
  }
  const open = current.requests.some(
    (request) => tables.interactions[request.interactionId]?.status === "open",
  );
  replace(channel.state, record, open ? current : undefined);
}

/** Updates the message with the request's new blocks, or with eve's default if Slack rejects them. */
async function updateCard(
  channel: SlackEventContext,
  record: SlackInteractionCardRecord,
  interactionId: string,
  card: RenderedRequestCard,
): Promise<SlackInteractionCardRecord | undefined> {
  const recorded = record.requests.find((request) => request.interactionId === interactionId)!;
  const rendered = withinCount(card.parts.controls.blocks, card, recorded);
  if (sameJson(rendered, recorded.blocks)) return undefined;
  const attempts = [{ blocks: rendered, text: card.parts.controls.text }];
  const fallback = withinCount(card.fallback.controls.blocks, card, recorded);
  if (!sameJson(fallback, rendered) && !sameJson(fallback, recorded.blocks)) {
    attempts.push({ blocks: fallback, text: card.fallback.controls.text });
  }
  for (const attempt of attempts) {
    const requests = record.requests.map((request) =>
      request.interactionId === interactionId ? { ...request, blocks: attempt.blocks } : request,
    );
    const ok = await callSlack(channel, "chat.update", interactionId, {
      blocks: requests.flatMap((request) => request.blocks),
      channel: record.channelId,
      text: attempt.text,
      ts: record.ts,
    });
    if (ok) return { ...record, requests };
  }
  return undefined;
}

/**
 * A rendering never grows past the blocks the request had when posted, so its message stays
 * under Slack's cap. A larger one falls back to eve's default, which is one block once the
 * request is answered or settled, or keeps the recorded blocks if that is larger too.
 */
function withinCount(
  blocks: readonly BlockKitBlock[],
  card: RenderedRequestCard,
  recorded: { readonly blocks: readonly BlockKitBlock[]; readonly count: number },
): readonly BlockKitBlock[] {
  if (blocks.length <= recorded.count) return blocks;
  log.warn("input request card grew past its posted size; using eve's default", {
    blocks: blocks.length,
    count: recorded.count,
  });
  const fallback = card.fallback.controls.blocks;
  return fallback.length <= recorded.count ? fallback : recorded.blocks;
}

async function retireDetails(
  channel: SlackEventContext,
  tables: SessionView,
  record: SlackInteractionCardRecord,
  interactionId: string,
): Promise<SlackInteractionCardRecord> {
  const detailsTs = record.requests.find(
    (request) => request.interactionId === interactionId,
  )?.detailsTs;
  if (detailsTs === undefined) return record;
  const records = channel.state.interactionCards ?? [];
  const shared = records.flatMap((candidate) =>
    candidate.requests.filter((request) => request.detailsTs === detailsTs),
  );
  if (shared.some((request) => tables.interactions[request.interactionId]?.status === "open")) {
    return record;
  }
  await callSlack(channel, "chat.delete", interactionId, {
    channel: record.channelId,
    ts: detailsTs,
  });
  // Requests settled in the same commit share the details message: delete it once.
  const withoutDetails = (candidate: SlackInteractionCardRecord): SlackInteractionCardRecord => ({
    ...candidate,
    requests: candidate.requests.map((request) => {
      if (request.detailsTs !== detailsTs) return request;
      const { detailsTs: _deleted, ...rest } = request;
      return rest;
    }),
  });
  channel.state.interactionCards = records.map(withoutDetails);
  return withoutDetails(record);
}

async function callSlack(
  channel: SlackEventContext,
  operation: "chat.delete" | "chat.update",
  requestId: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await channel.slack.request(operation, body);
    if (response.ok === true) return true;
    log.warn("failed to update input request message", {
      error: response.error,
      operation,
      requestId,
    });
  } catch (error) {
    logError(log, "failed to update input request message", error, { operation, requestId });
  }
  return false;
}

function announcementOf(interaction: Interaction, answeredBy: string | undefined): string {
  const by = answeredBy === undefined ? "" : ` by <@${answeredBy}>`;
  const approval = interaction.request.kind === "approval";
  if (approval && interaction.outcome === "accepted") return `Approved${by}.`;
  if (approval && interaction.outcome === "declined") return `Cancelled${by}.`;
  if (interaction.answer !== undefined) return `Answered${by}.`;
  return approval ? "This approval is no longer needed." : "This request is no longer needed.";
}

function cardOf(
  interaction: Interaction,
  destination: SlackApprovalChannel,
  ctx: RequestCardContext,
): SlackInteractionCard {
  const card: Mutable<SlackInteractionCard> = {
    audience:
      destination === "direct-message"
        ? "private"
        : normalizeChannelAudience(ctx.channel.state.audience),
    destination,
    interaction,
    view: ctx.view,
  };
  const answeredBy = answeredByOf(sessionTables(ctx.view), interaction, ctx.channel.state);
  if (answeredBy !== undefined) card.answeredBy = answeredBy;
  return card;
}

function cardRequest(
  interactionId: string,
  blocks: readonly BlockKitBlock[],
  detailsTs: string | undefined,
): SlackInteractionCardRequest {
  const request: Mutable<SlackInteractionCardRequest> = {
    blocks,
    count: blocks.length,
    interactionId,
  };
  if (detailsTs !== undefined) request.detailsTs = detailsTs;
  return request;
}

/** The Slack user behind the answer that decided the request, or that stands while it's open. */
function answeredByOf(
  tables: SessionView,
  interaction: Interaction,
  state: SlackChannelState,
): string | undefined {
  if (interaction.answer === undefined) return undefined;
  const { interactionId } = interaction;
  const row = tables.interactions[interactionId];
  const cause = row?.cause;
  const responseId =
    row?.status === "settled"
      ? cause !== undefined && "responseId" in cause
        ? cause.responseId
        : undefined
      : Object.values(tables.responses).findLast(
          (response) =>
            response.interactionId === interactionId &&
            response.status !== "settled" &&
            response.value !== undefined,
        )?.responseId;
  if (responseId === undefined) return undefined;
  return slackUserIdForPrincipal(state, responderOf(tables, responseId)?.id);
}

function remember(state: SlackChannelState, record: SlackInteractionCardRecord): void {
  state.interactionCards = [...(state.interactionCards ?? []), record];
}

function replace(
  state: SlackChannelState,
  record: SlackInteractionCardRecord,
  next: SlackInteractionCardRecord | undefined,
): void {
  const records = state.interactionCards ?? [];
  // Match by message, since `retireDetails` may already have replaced the record's object.
  state.interactionCards = records.flatMap((candidate) =>
    candidate.ts !== record.ts || candidate.channelId !== record.channelId
      ? [candidate]
      : next === undefined
        ? []
        : [next],
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
