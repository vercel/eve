import type { Interaction } from "#channel/interaction-prompts.js";
import { escapeSlackText } from "#compiled/@chat-adapter/slack/format.js";
import { createLogger, logError } from "#internal/logging.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import {
  isFreeformAction,
  isHitlAction,
  renderInteractionPostParts,
  type SlackHitlRoute,
} from "#public/channels/slack/hitl.js";
import { answeredBlocksFromActionBlock } from "#public/channels/slack/interaction-cards.js";
import {
  SLACK_MAX_BLOCKS_PER_MESSAGE,
  SLACK_SECTION_TEXT_MAX_LENGTH,
} from "#public/channels/slack/limits.js";
import type {
  SlackCardMessage,
  SlackInteractionCard,
  SlackInteractionCardChain,
  SlackInteractionCardParts,
} from "#public/channels/slack/renderers.js";
import { refusedPayloadError } from "#public/channels/slack/reply-delivery.js";
import { truncate } from "#public/channels/text.js";

const log = createLogger("slack.interaction-card");

const ANSWER_LABEL_MAX_LENGTH = 500;

export interface RenderedRequestCard {
  readonly parts: SlackInteractionCardParts;
  readonly fallback: SlackInteractionCardParts;
}

export function defaultInteractionCard(
  card: SlackInteractionCard,
  route?: SlackHitlRoute,
): SlackInteractionCardParts {
  const { interaction } = card;
  const open = renderInteractionPostParts(interaction, route);
  if (interaction.status === "open" && interaction.answer === undefined) return open;
  const { label, text } = endingOf(interaction);
  const answered =
    answeredBlocksFromActionBlock({
      answerLabel: label,
      block: open.controls.blocks[0],
      userId: card.answeredBy,
    })?.[0] ?? answeredSection(interaction.request.prompt, label, card.answeredBy);
  return { controls: { blocks: [answered as BlockKitBlock], text } };
}

export function endingOf(interaction: Interaction): {
  readonly label: string;
  readonly text: string;
} {
  const { answer, outcome, request } = interaction;
  if (answer !== undefined) {
    const option = request.options?.find((candidate) => candidate.id === answer.optionId);
    const label = option?.label ?? answer.text ?? answer.optionId ?? "Answered";
    return { label, text: `Answered: ${escapeSlackText(label)}` };
  }
  const label =
    outcome === "accepted" ? "Accepted" : outcome === "declined" ? "Declined" : "No longer needed";
  return { label, text: label };
}

export function threadNoteEndingOf(interaction: Interaction): string {
  const { answer, request } = interaction;
  if (answer === undefined) return endingOf(interaction).text;
  const option =
    request.kind === "approval"
      ? request.options?.find((candidate) => candidate.id === answer.optionId)
      : undefined;
  return option === undefined ? "Answered" : `Answered: ${escapeSlackText(option.label)}`;
}

function answeredSection(prompt: string, label: string, userId?: string): BlockKitBlock {
  const by = userId === undefined ? "" : ` by <@${userId}>`;
  const line = `:white_check_mark: *${truncate(escapeSlackText(label), ANSWER_LABEL_MAX_LENGTH)}*${by}`;
  const text = `${truncate(escapeSlackText(prompt), SLACK_SECTION_TEXT_MAX_LENGTH - line.length - 1)}\n${line}`;
  return { text: { text, type: "mrkdwn" }, type: "section" };
}

export function renderRequestCard(
  chain: SlackInteractionCardChain,
  card: SlackInteractionCard,
  route?: SlackHitlRoute,
): RenderedRequestCard {
  const fallback = defaultInteractionCard(card, route);
  const { interactionId } = card.interaction;
  try {
    const parts = JSON.parse(
      JSON.stringify(chain(card, (next) => defaultInteractionCard(next, route))),
    ) as SlackInteractionCardParts;
    const problem = invalidCardReason(parts, fallback);
    if (problem === undefined) return { fallback, parts };
    log.warn("interactionCard result rejected; using eve's default", { interactionId, problem });
  } catch (error) {
    logError(log, "interactionCard renderer failed; using eve's default", error, { interactionId });
  }
  return { fallback, parts: fallback };
}

function invalidCardReason(
  parts: SlackInteractionCardParts,
  fallback: SlackInteractionCardParts,
): string | undefined {
  for (const [name, message] of [
    ["controls", parts.controls],
    ["details", parts.details],
  ] as const) {
    if (message === undefined && name === "details") continue;
    if (!isMessage(message)) return `${name} is not a message with blocks and text`;
    if (message.blocks.length > SLACK_MAX_BLOCKS_PER_MESSAGE) {
      return `${name} has more than ${SLACK_MAX_BLOCKS_PER_MESSAGE} blocks`;
    }
  }
  if (parts.details !== undefined && eveControls(parts.details.blocks).length > 0) {
    return "details hold eve controls";
  }
  const expected = eveControls(fallback.controls.blocks);
  const actual = eveControls(parts.controls.blocks);
  if (expected.length !== actual.length || expected.some((control, i) => control !== actual[i])) {
    return expected.length === 0
      ? "controls of an answered or settled request hold eve controls"
      : "controls don't hold exactly eve's controls";
  }
  return undefined;
}

function isMessage(value: unknown): value is SlackCardMessage {
  if (typeof value !== "object" || value === null) return false;
  const { blocks, text } = value as Partial<SlackCardMessage>;
  return Array.isArray(blocks) && typeof text === "string";
}

export function compactDefault(fallback: SlackCardMessage): SlackCardMessage {
  const blocks = fallback.blocks.filter((block) => eveControls(block).length > 0);
  return blocks.length === 0 ? fallback : { ...fallback, blocks };
}

function eveControls(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const element = node as { action_id?: unknown; options?: unknown; value?: unknown };
    const actionId = element.action_id;
    if (typeof actionId === "string" && (isHitlAction(actionId) || isFreeformAction(actionId))) {
      const options = Array.isArray(element.options)
        ? element.options.map((option) => (option as { value?: unknown }).value).sort()
        : null;
      found.push(JSON.stringify([actionId, element.value ?? null, options]));
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(value);
  return found.sort();
}

export async function sendWithFallback<T>(
  send: (message: SlackCardMessage) => Promise<T>,
  message: SlackCardMessage,
  fallback: SlackCardMessage | undefined,
): Promise<T | undefined> {
  try {
    return await send(message);
  } catch (error) {
    if (refusedPayloadError(error) === undefined || sameJson(message, fallback)) throw error;
    logError(log, "Slack rejected a rendered input request; sending eve's default", error);
    return fallback === undefined ? undefined : await send(fallback);
  }
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
