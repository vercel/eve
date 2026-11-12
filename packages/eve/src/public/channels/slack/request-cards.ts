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
} from "#channel/interaction-prompts.js";
import { responderOf } from "#protocol/session-projection/reader.js";
import { createLogger, logError } from "#internal/logging.js";
import { slackSessionTargetOf } from "#public/channels/slack/api.js";
import { sessionTables } from "#protocol/session-projection/session-view.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import type { ChannelEventContext } from "#public/definitions/channel.js";
import {
  slackUserIdForPrincipal,
  slackUserIdFromAuthContext,
} from "#public/channels/slack/auth.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import {
  SLACK_MAX_BLOCKS_PER_MESSAGE,
  truncateMessageText,
} from "#public/channels/slack/limits.js";
import {
  deliverEphemeralInteraction,
  deliverPrivateInteraction,
  type PrivateInteractionDelivery,
} from "#public/channels/slack/private-approval-delivery.js";
import type {
  SlackCardMessage,
  SlackInteractionCard,
  SlackInteractionCardChain,
} from "#public/channels/slack/renderers.js";
import {
  isRefusedPayloadCode,
  refusedPayloadError,
} from "#public/channels/slack/reply-delivery.js";
import {
  compactDefault,
  type RenderedRequestCard,
  renderRequestCard,
  sameJson,
  threadNoteEndingOf,
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

type PrivateDestination = Exclude<SlackApprovalChannel, "thread">;

/**
 * Slack echoes the whole controls message on every click (#1909). A request's controls beyond a
 * compact card's size, such as an approval's input preview, count toward a per-message budget, so
 * a batch of large approvals splits across messages instead of growing one echo.
 */
const COMPACT_CARD_BYTES = 1000;
const CONTROLS_MESSAGE_EXTRA_BYTES = 2000;

/**
 * Posts a commit's requests: each `approvalChannel` sends to the thread joins one batch, details
 * first, then controls, grouped under Slack's 50-block cap and, for controls, a size budget; each
 * sent privately, to a DM or as an ephemeral message, posts alone.
 */
export async function postRequestCards(
  batch: RequestBatch,
  ctx: RequestCardContext,
  chain: SlackInteractionCardChain,
  approvalChannel: SlackApprovalChannelResolver | undefined,
): Promise<void> {
  forgetSettledCards(ctx);
  const privateRequests: { request: Interaction; destination: PrivateDestination }[] = [];
  const threadRequests: Interaction[] = [];
  for (const request of batch.requests) {
    const destination =
      approvalChannel === undefined ? "thread" : await approvalChannel(request, ctx);
    if (destination === "direct-message" || destination === "ephemeral") {
      privateRequests.push({ destination, request });
    } else {
      threadRequests.push(request);
    }
  }
  await postThreadCards(threadRequests, ctx, chain);
  for (const { destination, request } of privateRequests) {
    await postPrivateCard(request, destination, ctx, chain);
  }
}

interface CardEntry extends RenderedRequestCard {
  readonly interactionId: string;
}

interface CardPart {
  readonly interactionId: string;
  readonly message: SlackCardMessage;
}

async function postThreadCards(
  requests: readonly Interaction[],
  ctx: RequestCardContext,
  chain: SlackInteractionCardChain,
): Promise<void> {
  const { channel } = ctx;
  const channelId = channel.state.channelId;
  if (requests.length === 0) return;
  if (channelId === null) {
    log.warn("thread input requests not delivered because the session has no Slack channel", {
      requestIds: requests.map((request) => request.interactionId),
      sessionId: ctx.session.id,
    });
    return;
  }
  // A card in a code channel sits outside any thread, so its clicks carry the session's address.
  const route = channel.slack.codeChannel ? slackSessionTargetOf(channel.slack) : undefined;
  const entries = requests.map((request): CardEntry => ({
    interactionId: request.interactionId,
    ...renderRequestCard(chain, cardOf(request, "thread", ctx), route),
  }));
  const post = async (message: SlackCardMessage) =>
    (await channel.thread.post({ blocks: [...message.blocks], text: message.text })).id;

  const detailsTs = new Map<string, string>();
  await postGroups(entries, "details", post, (parts, ts) => {
    for (const part of parts) detailsTs.set(part.interactionId, ts);
  });
  // Each controls message is recorded as it posts, so a later group's failure keeps it tracked.
  await postGroups(entries, "controls", post, (parts, ts) => {
    const record: Mutable<SlackInteractionCardRecord> = {
      channelId,
      destination: "thread",
      requests: parts.map(({ interactionId, message }) =>
        cardRequest(interactionId, message.blocks, detailsTs.get(interactionId)),
      ),
      ts,
    };
    if (route !== undefined) record.route = route;
    remember(channel.state, record);
  });
}

/**
 * Posts each group of `kind` messages. A group whose content Slack refuses posts again with each
 * request's default, regrouped, since the defaults can need more blocks than the rendered ones.
 */
async function postGroups(
  entries: readonly CardEntry[],
  kind: "controls" | "details",
  post: (message: SlackCardMessage) => Promise<string>,
  posted: (parts: readonly CardPart[], ts: string) => void,
): Promise<void> {
  const send = async (parts: readonly CardPart[]) => {
    const ts = await post(joinParts(parts));
    if (ts) posted(parts, ts);
  };
  const extraBytes = kind === "controls" ? CONTROLS_MESSAGE_EXTRA_BYTES : Infinity;
  for (const group of groupParts(entries, (entry) => entry.parts[kind], extraBytes)) {
    try {
      await send(group);
    } catch (error) {
      const members = entries.filter((entry) =>
        group.some((part) => part.interactionId === entry.interactionId),
      );
      const unchanged = members.every((entry) => sameJson(entry.parts[kind], entry.fallback[kind]));
      if (refusedPayloadError(error) === undefined || unchanged) throw error;
      logError(log, "Slack refused rendered input requests; posting eve's defaults", error);
      for (const retry of groupParts(members, (entry) => entry.fallback[kind], extraBytes)) {
        await send(retry);
      }
    }
  }
}

function groupParts(
  entries: readonly CardEntry[],
  messageOf: (entry: CardEntry) => SlackCardMessage | undefined,
  extraBytes: number,
): CardPart[][] {
  const groups: CardPart[][] = [];
  let blocks = 0;
  let extra = 0;
  for (const entry of entries) {
    const message = messageOf(entry);
    if (message === undefined) continue;
    const excess = Math.max(0, JSON.stringify(message.blocks).length - COMPACT_CARD_BYTES);
    const current = groups.at(-1);
    if (
      current &&
      blocks + message.blocks.length <= SLACK_MAX_BLOCKS_PER_MESSAGE &&
      extra + excess <= extraBytes
    ) {
      current.push({ interactionId: entry.interactionId, message });
      blocks += message.blocks.length;
      extra += excess;
    } else {
      groups.push([{ interactionId: entry.interactionId, message }]);
      blocks = message.blocks.length;
      extra = excess;
    }
  }
  return groups;
}

function joinParts(parts: readonly CardPart[]): SlackCardMessage {
  return {
    blocks: parts.flatMap((part) => part.message.blocks),
    text: truncateMessageText(parts.map((part) => part.message.text).join("\n")),
  };
}

/**
 * Posts one request only the person behind the turn sees, in their DM or as an ephemeral message
 * in the thread, and a note in the thread naming who it waits on, which shows the outcome later.
 * The card always carries the session's route: a click on a DM, or on an ephemeral Slack showed
 * outside a thread without replies, can't name the thread it answers.
 */
async function postPrivateCard(
  request: Interaction,
  destination: PrivateDestination,
  ctx: RequestCardContext,
  chain: SlackInteractionCardChain,
): Promise<void> {
  const { channel } = ctx;
  const reviewer = reviewerOf(ctx);
  if (!reviewer) {
    log.warn(`${destination} input request not delivered because no reviewer was resolved`, {
      requestId: request.interactionId,
      sessionId: ctx.session.id,
    });
    return;
  }
  const route = slackSessionTargetOf(channel.slack);
  const card = renderRequestCard(chain, cardOf(request, destination, ctx), route);
  let announcementTs: string | undefined;
  let delivery: PrivateInteractionDelivery;
  if (destination === "ephemeral") {
    // Slack hides an ephemeral in a thread without replies, so the note goes first.
    announcementTs = await announcePrivateRequest(request, reviewer, ctx);
    try {
      delivery = await deliverEphemeralInteraction({
        card,
        channelId: channel.slack.channelId,
        reviewer,
        thread: channel.thread,
      });
    } catch (error) {
      // Nothing would ever update a note whose card never posted.
      if (announcementTs !== undefined && channel.state.channelId !== null) {
        await callSlack(channel, "chat.delete", request.interactionId, {
          channel: channel.state.channelId,
          ts: announcementTs,
        });
      }
      throw error;
    }
  } else {
    delivery = await deliverPrivateInteraction({
      card,
      previewMessageTs: channel.state.triggeringMessageTs ?? channel.slack.threadTs,
      reviewer,
      slack: channel.slack,
    });
    // A DM that failed, such as without `im:write`, must leave no note claiming it waits.
    announcementTs = await announcePrivateRequest(request, reviewer, ctx);
  }
  const record: Mutable<SlackInteractionCardRecord> = {
    channelId: delivery.channelId,
    destination,
    requests: [cardRequest(request.interactionId, delivery.blocks, delivery.detailsTs)],
    route,
    ts: delivery.ts,
  };
  if (announcementTs !== undefined) record.announcementTs = announcementTs;
  remember(channel.state, record);
}

/** The Slack user a private request goes to: the one behind the turn. */
function reviewerOf(ctx: RequestCardContext): string | null | undefined {
  return slackUserIdFromAuthContext(ctx.session.auth.current) ?? ctx.channel.state.triggeringUserId;
}

async function announcePrivateRequest(
  request: Interaction,
  reviewer: string,
  ctx: RequestCardContext,
): Promise<string | undefined> {
  try {
    const announcement = await ctx.channel.thread.post(
      `Waiting on ${request.request.kind === "approval" ? "approval" : "a response"} from <@${reviewer}>…`,
    );
    return announcement.id || undefined;
  } catch (error) {
    logError(log, "failed to announce private input request", error, {
      requestId: request.interactionId,
      sessionId: ctx.session.id,
    });
    return undefined;
  }
}

/**
 * Posts an ephemeral request's card again once a refused answer leaves it open: its click already
 * replaced the card, and Slack can't edit an ephemeral back, so only a new one brings the controls.
 */
async function repostEphemeralCard(
  record: SlackInteractionCardRecord,
  interactionId: string,
  ctx: RequestCardContext,
  chain: SlackInteractionCardChain,
): Promise<SlackInteractionCardRecord> {
  const interaction = interactionOf(sessionTables(ctx.view), interactionId);
  const reviewer = reviewerOf(ctx);
  if (interaction === undefined || !reviewer) return record;
  const card = cardOf(interaction, "ephemeral", ctx);
  // An admitted answer stands, and the card its click left already shows it.
  if (card.interaction.answer !== undefined) return record;
  const delivery = await deliverEphemeralInteraction({
    card: renderRequestCard(chain, card, record.route),
    channelId: record.channelId,
    reviewer,
    thread: ctx.channel.thread,
  });
  return {
    ...record,
    requests: [cardRequest(interactionId, delivery.blocks, undefined)],
    ts: delivery.ts,
  };
}

/**
 * Shows an open request's changed answer: an admitted one, or the controls again once it was
 * refused. A request already settled in the commit is left to `interaction.settled`.
 */
export async function showAnswerChange(
  interactionId: string,
  ctx: RequestCardContext,
  chain: SlackInteractionCardChain,
): Promise<void> {
  forgetSettledCards(ctx);
  const record = recordOf(ctx.channel.state, interactionId);
  if (record === undefined) return;
  if (sessionTables(ctx.view).interactions[interactionId]?.status !== "open") return;
  const next =
    record.destination === "ephemeral"
      ? await repostEphemeralCard(record, interactionId, ctx, chain)
      : await writeRequests(ctx, chain, record, [interactionId]);
  replace(ctx.channel.state, record, next);
}

/**
 * Writes a settled request's card. Every request of its message that settled in the same commit
 * without its settled rendering written joins the one update, since the commit's view already
 * shows them settled. Then deletes each details message whose requests have all written their
 * settled rendering, reports the outcome in a private request's thread note, and forgets the
 * message once every request in it has.
 */
export async function settleRequestCard(
  interactionId: string,
  ctx: RequestCardContext,
  chain: SlackInteractionCardChain,
): Promise<void> {
  const { channel } = ctx;
  forgetSettledCards(ctx);
  const record = recordOf(channel.state, interactionId);
  const tables = sessionTables(ctx.view);
  const settling = (record?.requests ?? []).filter(
    (request) =>
      request.settled !== true && tables.interactions[request.interactionId]?.status === "settled",
  );
  if (record === undefined || settling.length === 0) return;

  const ids = settling.map((request) => request.interactionId);
  const written = await writeRequests(ctx, chain, record, ids);
  const current: SlackInteractionCardRecord = {
    ...written,
    requests: written.requests.map((request) =>
      ids.includes(request.interactionId) ? { ...request, settled: true } : request,
    ),
  };
  replace(channel.state, record, current);

  if (current.announcementTs !== undefined && channel.state.channelId !== null) {
    for (const id of ids) {
      const interaction = interactionOf(tables, id);
      if (interaction === undefined) continue;
      const card = cardOf(interaction, current.destination, ctx);
      const by = card.answeredBy === undefined ? "" : ` by <@${card.answeredBy}>`;
      await callSlack(channel, "chat.update", id, {
        channel: channel.state.channelId,
        text: `${threadNoteEndingOf(card.interaction)}${by}.`,
        ts: current.announcementTs,
      });
    }
  }
  for (const request of settling) {
    if (request.detailsTs !== undefined) await retireDetails(channel, current, request.detailsTs);
  }
  if (current.requests.every((request) => request.settled === true)) {
    replace(channel.state, current, undefined);
  }
}

interface RequestChange {
  readonly interactionId: string;
  readonly rendered: SlackCardMessage;
  readonly fallback: SlackCardMessage;
  readonly compact: SlackCardMessage;
}

/**
 * Renders `ids` again and updates the message once if their blocks changed. The message must
 * stay within Slack's 50 blocks, so eve uses the renderers' output if it fits, else eve's
 * defaults, else the defaults at their smallest, which always fit, since every request held at
 * least one block when posted. When Slack refuses the content, eve sends the next of those once
 * more. Returns the record as Slack now shows it. An ephemeral message can't be updated: its
 * click replaces it, and its thread note shows the outcome.
 */
async function writeRequests(
  ctx: RequestCardContext,
  chain: SlackInteractionCardChain,
  record: SlackInteractionCardRecord,
  ids: readonly string[],
): Promise<SlackInteractionCardRecord> {
  if (record.destination === "ephemeral") return record;
  const tables = sessionTables(ctx.view);
  const changes = ids.flatMap((id): RequestChange[] => {
    const interaction = interactionOf(tables, id);
    if (interaction === undefined) return [];
    const card = renderRequestCard(
      chain,
      cardOf(interaction, record.destination, ctx),
      record.route,
    );
    const fallback = card.fallback.controls;
    return [
      {
        compact: compactDefault(fallback),
        fallback,
        interactionId: id,
        rendered: card.parts.controls,
      },
    ];
  });
  const blocksOf = (requests: readonly SlackInteractionCardRequest[]) =>
    requests.flatMap((request) => request.blocks);
  const candidates = (["rendered", "fallback", "compact"] as const)
    .map((kind) => {
      const texts: string[] = [];
      const requests = record.requests.map((request) => {
        const change = changes.find(
          (candidate) => candidate.interactionId === request.interactionId,
        );
        if (change === undefined) return request;
        texts.push(change[kind].text);
        return { ...request, blocks: change[kind].blocks };
      });
      return { kind, requests, text: truncateMessageText(texts.join("\n")) };
    })
    .filter((candidate) => blocksOf(candidate.requests).length <= SLACK_MAX_BLOCKS_PER_MESSAGE);
  const [first, ...rest] = candidates;
  if (first === undefined) return record;
  if (first.kind !== "rendered") {
    log.warn("input request card would pass Slack's 50 blocks; using eve's default", {
      fallback: first.kind,
      requestIds: ids,
    });
  }
  if (sameJson(blocksOf(first.requests), blocksOf(record.requests))) return record;
  const update = async (message: (typeof candidates)[number]) =>
    await callSlack(ctx.channel, "chat.update", ids.join(","), {
      blocks: blocksOf(message.requests),
      channel: record.channelId,
      text: message.text,
      ts: record.ts,
    });
  const result = await update(first);
  if (result === "ok") return { ...record, requests: first.requests };
  const retry = rest.find(
    (candidate) => !sameJson(blocksOf(candidate.requests), blocksOf(first.requests)),
  );
  if (result !== "refused" || retry === undefined) return record;
  if (sameJson(blocksOf(retry.requests), blocksOf(record.requests))) return record;
  return (await update(retry)) === "ok" ? { ...record, requests: retry.requests } : record;
}

/** Deletes a details message once every request it covers has written its settled rendering. */
async function retireDetails(
  channel: SlackEventContext,
  record: SlackInteractionCardRecord,
  detailsTs: string,
): Promise<void> {
  const records = channel.state.interactionCards ?? [];
  const covered = records.flatMap((candidate) =>
    candidate.requests.filter((request) => request.detailsTs === detailsTs),
  );
  // None covered means an earlier request of the same commit already deleted it.
  if (covered.length === 0 || covered.some((request) => request.settled !== true)) return;
  await callSlack(channel, "chat.delete", detailsTs, { channel: record.channelId, ts: detailsTs });
  channel.state.interactionCards = records.map((candidate) => ({
    ...candidate,
    requests: candidate.requests.map((request) => {
      if (request.detailsTs !== detailsTs) return request;
      const { detailsTs: _deleted, ...rest } = request;
      return rest;
    }),
  }));
}

/**
 * Makes one Slack call, never throwing: `refused` when Slack refused the message's content, so
 * eve's default is worth sending, and `failed` for anything else, which must not resend.
 */
async function callSlack(
  channel: SlackEventContext,
  operation: "chat.delete" | "chat.update",
  requestId: string,
  body: Record<string, unknown>,
): Promise<"ok" | "refused" | "failed"> {
  try {
    const response = await channel.slack.request(operation, body);
    if (response.ok === true) return "ok";
    log.warn("failed to update input request message", {
      error: response.error,
      operation,
      requestId,
    });
    return isRefusedPayloadCode(response.error) ? "refused" : "failed";
  } catch (error) {
    logError(log, "failed to update input request message", error, { operation, requestId });
    return "failed";
  }
}

function cardOf(
  interaction: Interaction,
  destination: SlackApprovalChannel,
  ctx: RequestCardContext,
): SlackInteractionCard {
  const tables = sessionTables(ctx.view);
  const standing = standingOf(tables, interaction);
  const card: Mutable<SlackInteractionCard> = {
    audience:
      destination === "thread" ? normalizeChannelAudience(ctx.channel.state.audience) : "private",
    destination,
    interaction: standing.interaction,
    view: ctx.view,
  };
  const answeredBy =
    standing.responseId === undefined
      ? undefined
      : slackUserIdForPrincipal(ctx.channel.state, responderOf(tables, standing.responseId)?.id);
  if (answeredBy !== undefined) card.answeredBy = answeredBy;
  return card;
}

function cardRequest(
  interactionId: string,
  blocks: readonly BlockKitBlock[],
  detailsTs: string | undefined,
): SlackInteractionCardRequest {
  const request: Mutable<SlackInteractionCardRequest> = { blocks, interactionId };
  if (detailsTs !== undefined) request.detailsTs = detailsTs;
  return request;
}

/**
 * The request as it stands, with the response behind its answer. A settled request keeps the
 * answer that decided it. While open, only the latest admitted answer stands: a submitted one
 * may still be refused by a response policy, a check, or a sign-in.
 */
function standingOf(
  tables: SessionView,
  interaction: Interaction,
): { readonly interaction: Interaction; readonly responseId: string | undefined } {
  const { interactionId } = interaction;
  if (interaction.status === "settled") {
    const cause = tables.interactions[interactionId]?.cause;
    const decided =
      interaction.answer !== undefined && cause !== undefined && "responseId" in cause;
    return { interaction, responseId: decided ? cause.responseId : undefined };
  }
  const { answer: _latest, ...open } = interaction;
  const admitted = Object.values(tables.responses).findLast(
    (response) =>
      response.interactionId === interactionId &&
      response.status === "admitted" &&
      response.value !== undefined,
  );
  if (admitted?.value === undefined) return { interaction: open, responseId: undefined };
  return {
    interaction: { ...open, answer: { ...admitted.value, interactionId } },
    responseId: admitted.responseId,
  };
}

/**
 * Forgets messages whose requests all settled in earlier commits, such as ones whose settled
 * rendering eve never wrote because a renderer's `interaction.settled` skipped `next()`.
 */
function forgetSettledCards(ctx: RequestCardContext): void {
  const { state } = ctx.channel;
  const records = state.interactionCards;
  if (records === undefined || records.length === 0) return;
  const tables = sessionTables(ctx.view);
  const line = ctx.position.line;
  const live = records.filter((record) =>
    record.requests.some((request) => {
      const row = tables.interactions[request.interactionId];
      return row !== undefined && (row.status === "open" || (row.closedAt ?? line) >= line);
    }),
  );
  if (live.length !== records.length) state.interactionCards = live;
}

function recordOf(
  state: SlackChannelState,
  interactionId: string,
): SlackInteractionCardRecord | undefined {
  return state.interactionCards?.find((candidate) =>
    candidate.requests.some((request) => request.interactionId === interactionId),
  );
}

function remember(state: SlackChannelState, record: SlackInteractionCardRecord): void {
  state.interactionCards = [...(state.interactionCards ?? []), record];
}

/** Replaces the record of `record`'s message with `next`, or forgets it. */
function replace(
  state: SlackChannelState,
  record: SlackInteractionCardRecord,
  next: SlackInteractionCardRecord | undefined,
): void {
  const records = state.interactionCards ?? [];
  // Match by message, since `retireDetails` may already have replaced the record's object.
  state.interactionCards = records.flatMap((candidate) => {
    if (candidate.ts !== record.ts || candidate.channelId !== record.channelId) return [candidate];
    return next === undefined ? [] : [next];
  });
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
