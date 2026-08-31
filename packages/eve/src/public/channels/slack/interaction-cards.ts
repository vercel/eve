import { resolveSlackBotToken } from "#public/channels/slack/api.js";
import { buildAnsweredBlocks, isHitlAction } from "#public/channels/slack/hitl.js";
import {
  SLACK_CARD_SUBTEXT_MAX_LENGTH,
  truncateCardSubtext,
} from "#public/channels/slack/limits.js";
import type {
  InteractionHandlerDeps,
  ParsedBlockActionsPayload,
} from "#public/channels/slack/interactions.js";

function buildAnsweredHitlMessageBlocks(input: {
  readonly actionId: string;
  readonly answerLabel: string;
  readonly messageBlocks: readonly unknown[];
  readonly userId: string;
}): unknown[] {
  const actionBlockIndex = input.messageBlocks.findIndex((block) =>
    blockContainsActionId(block, input.actionId),
  );
  if (actionBlockIndex === -1) {
    return buildAnsweredBlocks({
      promptBlocks: findPromptBlocks(input.messageBlocks),
      answerLabel: input.answerLabel,
      userId: input.userId,
    });
  }

  const actionBlock = input.messageBlocks[actionBlockIndex];
  const answeredBlocks =
    answeredBlocksFromActionBlock({
      answerLabel: input.answerLabel,
      block: actionBlock,
      userId: input.userId,
    }) ??
    buildAnsweredBlocks({
      promptBlocks: promptBlocksFromActionBlock(actionBlock),
      answerLabel: input.answerLabel,
      userId: input.userId,
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
    actionsContainActionId(block.actions, actionId)
  );
}

function actionsContainActionId(actions: unknown, actionId: string): boolean {
  if (!Array.isArray(actions)) return false;
  return actions.some((element) => isObjectRecord(element) && element.action_id === actionId);
}

function answeredBlocksFromActionBlock(input: {
  readonly answerLabel: string;
  readonly block: unknown;
  readonly userId: string;
}): unknown[] | undefined {
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
  readonly userId: string;
}): string {
  const attribution = input.userId.length > 0 ? ` by <@${input.userId}>` : "";
  const labelBudget =
    SLACK_CARD_SUBTEXT_MAX_LENGTH -
    ANSWERED_CARD_SUBTEXT_PREFIX.length -
    ANSWERED_CARD_SUBTEXT_SUFFIX.length -
    attribution.length;
  const label = truncateWithEllipsis(input.answerLabel, labelBudget);
  return truncateCardSubtext(
    `${ANSWERED_CARD_SUBTEXT_PREFIX}${label}${ANSWERED_CARD_SUBTEXT_SUFFIX}${attribution}`,
  );
}

function truncateWithEllipsis(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;
  const sliceLength = Math.max(0, maxLength - 3);
  return `${value.slice(0, sliceLength).trimEnd()}...`;
}

function promptBlocksFromActionBlock(block: unknown): unknown[] {
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

export async function updateAnsweredHitlCard(
  interaction: ParsedBlockActionsPayload,
  deps: InteractionHandlerDeps,
): Promise<void> {
  const hitlAction = interaction.actions.find((action) => isHitlAction(action.actionId));
  if (!hitlAction?.messageTs) return;

  const answerLabel = hitlAction.label ?? hitlAction.selectedOptionValue ?? hitlAction.value;
  if (!answerLabel) return;

  const blocks = buildAnsweredHitlMessageBlocks({
    actionId: hitlAction.actionId,
    answerLabel,
    messageBlocks: interaction.messageBlocks,
    userId: hitlAction.user.id,
  });
  await updateAnsweredCard({
    answerLabel,
    blocks,
    channelId: interaction.channelId,
    deps,
    installationTeamId: interaction.installationTeamId,
    messageTs: hitlAction.messageTs,
  });
}

export async function updateAnsweredFreeformCard(input: {
  readonly channelId: string;
  readonly messageTs: string;
  readonly answerLabel: string;
  readonly userId?: string;
  readonly installationTeamId?: string;
  readonly deps: InteractionHandlerDeps;
}): Promise<void> {
  await updateAnsweredCard({
    ...input,
    blocks: buildAnsweredBlocks({
      promptBlocks: [],
      answerLabel: input.answerLabel,
      userId: input.userId,
    }),
  });
}

async function updateAnsweredCard(input: {
  readonly answerLabel: string;
  readonly blocks: unknown[];
  readonly channelId: string;
  readonly deps: InteractionHandlerDeps;
  readonly installationTeamId?: string;
  readonly messageTs: string;
}): Promise<void> {
  const token = await resolveSlackBotToken(input.deps.config.credentials?.botToken, {
    teamId: input.installationTeamId,
  });
  const response = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: input.channelId,
      ts: input.messageTs,
      blocks: input.blocks,
      text: `Answered: ${input.answerLabel}`,
    }),
  });
  if (!response.ok) throw new Error(`Slack chat.update returned HTTP ${response.status}`);
}
