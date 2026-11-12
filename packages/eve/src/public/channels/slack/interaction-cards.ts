import { sendSlackResponseUrl } from "#compiled/@chat-adapter/slack/api.js";
import { escapeSlackText } from "#compiled/@chat-adapter/slack/format.js";
import { callSlackApi } from "#public/channels/slack/api.js";
import { buildAnsweredBlocks, isHitlAction } from "#public/channels/slack/hitl.js";
import {
  SLACK_CARD_SUBTEXT_MAX_LENGTH,
  truncateCardSubtext,
} from "#public/channels/slack/limits.js";
import type {
  InteractionHandlerDeps,
  ParsedBlockActionsPayload,
} from "#public/channels/slack/interactions.js";
import { truncate as truncateWithEllipsis } from "#public/channels/text.js";

/**
 * What a settled card shows in place of its controls: the line that replaces
 * them, the notification text of the update, such as `Answered: Saturday` or
 * `No longer active`, and who answered when the card credits someone.
 */
export interface SettledCard {
  readonly label: string;
  readonly text: string;
  readonly userId?: string;
}

function buildSettledHitlMessageBlocks(input: {
  readonly actionId: string;
  readonly card: SettledCard;
  readonly messageBlocks: readonly unknown[];
}): unknown[] {
  const actionBlockIndex = input.messageBlocks.findIndex((block) =>
    blockContainsActionId(block, input.actionId),
  );
  if (actionBlockIndex === -1) {
    return buildAnsweredBlocks({
      promptBlocks: findPromptBlocks(input.messageBlocks),
      answerLabel: input.card.label,
      userId: input.card.userId,
    });
  }

  const actionBlock = input.messageBlocks[actionBlockIndex];
  const answeredBlocks =
    answeredBlocksFromActionBlock({
      answerLabel: input.card.label,
      block: actionBlock,
      userId: input.card.userId,
    }) ??
    buildAnsweredBlocks({
      promptBlocks: promptBlocksFromActionBlock(actionBlock),
      answerLabel: input.card.label,
      userId: input.card.userId,
    });
  return [
    ...input.messageBlocks.slice(0, actionBlockIndex),
    ...answeredBlocks,
    ...input.messageBlocks.slice(actionBlockIndex + 1),
  ];
}

function findPromptBlocks(blocks: readonly unknown[]): unknown[] {
  const promptBlocks: unknown[] = [];
  for (const block of blocks) {
    if (!isObjectRecord(block)) continue;
    const type = block.type;
    if (type === "actions") break;
    if (type === "section" || type === "context" || type === "divider" || type === "image") {
      promptBlocks.push(block);
    }
  }
  return promptBlocks;
}

function blockContainsActionId(block: unknown, actionId: string): boolean {
  if (!isObjectRecord(block)) return false;
  return (
    actionsContainActionId(block.elements, actionId) ||
    actionsContainActionId(block.actions, actionId) ||
    (Array.isArray(block.child_blocks) &&
      block.child_blocks.some((child) => blockContainsActionId(child, actionId)))
  );
}

function actionsContainActionId(actions: unknown, actionId: string): boolean {
  if (!Array.isArray(actions)) return false;
  return actions.some((element) => isObjectRecord(element) && element.action_id === actionId);
}

/**
 * Retires an answered `card` or approval `container` in place: same single block, buttons
 * replaced by the answer. A container keeps its title and input preview as the record of what
 * was decided.
 */
export function answeredBlocksFromActionBlock(input: {
  readonly answerLabel: string;
  readonly block: unknown;
  readonly userId?: string;
}): unknown[] | undefined {
  if (isObjectRecord(input.block) && input.block.type === "container") {
    const { subtitle: _subtitle, ...container } = withoutContainerActions(input.block);
    const answer = {
      type: "context",
      elements: [{ type: "mrkdwn", text: formatAnsweredCardSubtext(input) }],
    };
    return [{ ...container, child_blocks: [...container.child_blocks, answer] }];
  }
  if (!isObjectRecord(input.block) || input.block.type !== "card") return undefined;

  const { actions: _actions, subtext: _subtext, ...blockWithoutActions } = input.block;
  const answeredCard = {
    ...blockWithoutActions,
    subtext: {
      type: "mrkdwn",
      text: formatAnsweredCardSubtext(input),
      verbatim: false,
    },
  };
  return hasCardContent(answeredCard) ? [answeredCard] : undefined;
}

const ANSWERED_CARD_SUBTEXT_PREFIX = ":white_check_mark: *";
const ANSWERED_CARD_SUBTEXT_SUFFIX = "*";

function formatAnsweredCardSubtext(input: {
  readonly answerLabel: string;
  readonly userId?: string;
}): string {
  const attribution = input.userId === undefined ? "" : ` by <@${input.userId}>`;
  const labelBudget =
    SLACK_CARD_SUBTEXT_MAX_LENGTH -
    ANSWERED_CARD_SUBTEXT_PREFIX.length -
    ANSWERED_CARD_SUBTEXT_SUFFIX.length -
    attribution.length;
  const label = truncateWithEllipsis(escapeSlackText(input.answerLabel), labelBudget);
  return truncateCardSubtext(
    `${ANSWERED_CARD_SUBTEXT_PREFIX}${label}${ANSWERED_CARD_SUBTEXT_SUFFIX}${attribution}`,
  );
}

function withoutContainerActions(
  block: Record<string, unknown>,
): Record<string, unknown> & { child_blocks: unknown[] } {
  const children = Array.isArray(block.child_blocks) ? block.child_blocks : [];
  return {
    ...block,
    child_blocks: children.filter((child) => !isObjectRecord(child) || child.type !== "actions"),
  };
}

function promptBlocksFromActionBlock(block: unknown): unknown[] {
  if (isObjectRecord(block) && block.type === "container") return [withoutContainerActions(block)];
  if (!isObjectRecord(block) || block.type !== "card") return [];

  const { actions: _actions, ...blockWithoutActions } = block;
  return hasCardContent(blockWithoutActions) ? [blockWithoutActions] : [];
}

function hasCardContent(block: Record<string, unknown>): boolean {
  return block.body !== undefined || block.title !== undefined || block.hero_image !== undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Replaces a pressed HITL card's controls with `card`. */
export async function settleHitlCard(
  interaction: ParsedBlockActionsPayload,
  deps: InteractionHandlerDeps,
  card: SettledCard,
): Promise<void> {
  const hitlAction = interaction.actions.find((action) => isHitlAction(action.actionId));
  if (!hitlAction?.messageTs) return;

  await updateSettledCard({
    blocks: buildSettledHitlMessageBlocks({
      actionId: hitlAction.actionId,
      card,
      messageBlocks: interaction.messageBlocks,
    }),
    card,
    channelId: interaction.channelId,
    deps,
    installationTeamId: interaction.installationTeamId,
    messageTs: hitlAction.messageTs,
    responseUrl: interaction.ephemeral ? hitlAction.responseUrl : undefined,
  });
}

/** Replaces a freeform card's controls with `card`. */
export async function settleFreeformCard(input: {
  readonly card: SettledCard;
  readonly channelId: string;
  readonly deps: InteractionHandlerDeps;
  readonly installationTeamId?: string;
  readonly messageTs: string;
  /** The `response_url` of the click that opened the modal, when the card was ephemeral. */
  readonly responseUrl?: string;
}): Promise<void> {
  await updateSettledCard({
    ...input,
    blocks: buildAnsweredBlocks({
      promptBlocks: [],
      answerLabel: input.card.label,
      userId: input.card.userId,
    }),
  });
}

async function updateSettledCard(input: {
  readonly blocks: unknown[];
  readonly card: SettledCard;
  readonly channelId: string;
  readonly deps: InteractionHandlerDeps;
  readonly installationTeamId?: string;
  readonly messageTs: string;
  readonly responseUrl?: string | undefined;
}): Promise<void> {
  if (input.responseUrl !== undefined) {
    // Slack's own host, so the transport's `fetch`, confined to the configured bases, stays out.
    await sendSlackResponseUrl(input.responseUrl, {
      blocks: input.blocks,
      replaceOriginal: true,
      text: input.card.text,
    });
    return;
  }
  await callSlackApi({
    api: input.deps.api,
    botToken: input.deps.config.credentials?.botToken,
    context: { teamId: input.installationTeamId },
    operation: "chat.update",
    body: {
      channel: input.channelId,
      ts: input.messageTs,
      blocks: input.blocks,
      text: input.card.text,
    },
  });
}
