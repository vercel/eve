/**
 * Renders one approval, question, or budget prompt through the renderers' `interactionCard`
 * chain, and checks the result against eve's own controls so a renderer can restyle a card but
 * never break how its clicks route.
 */

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

/** Room an answer label gets in the answered line, so the prompt keeps the rest. */
const ANSWER_LABEL_MAX_LENGTH = 500;

/** One request's messages, and eve's default for it, sent when Slack rejects the rendered ones. */
export interface RenderedRequestCard {
  readonly parts: SlackInteractionCardParts;
  readonly fallback: SlackInteractionCardParts;
}

/**
 * eve's default card: an open, unanswered request's controls, or once answered or settled, one
 * block naming the answer and, when known, who gave it.
 */
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

/**
 * How an answered or settled request reads: the answer's label, or how it ended without one,
 * and the notification text. The card and a direct-message request's thread note share it.
 */
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

function answeredSection(prompt: string, label: string, userId?: string): BlockKitBlock {
  const by = userId === undefined ? "" : ` by <@${userId}>`;
  const line = `:white_check_mark: *${truncate(escapeSlackText(label), ANSWER_LABEL_MAX_LENGTH)}*${by}`;
  const text = `${truncate(escapeSlackText(prompt), SLACK_SECTION_TEXT_MAX_LENGTH - line.length - 1)}\n${line}`;
  return { text: { text, type: "mrkdwn" }, type: "section" };
}

/**
 * Runs `chain` for one request, falling back to eve's default when the renderer throws or its
 * result fails {@link invalidCardReason}. The default renders from the original interaction, so
 * a changed card handed to `next` can't change which controls are expected.
 */
export function renderRequestCard(
  chain: SlackInteractionCardChain,
  card: SlackInteractionCard,
  route?: SlackHitlRoute,
): RenderedRequestCard {
  const fallback = defaultInteractionCard(card, route);
  const { interactionId } = card.interaction;
  try {
    // A copy that survives JSON is what eve persists, so state in memory matches state on disk.
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

/**
 * eve's default at its smallest: only the block holding its controls, which every open default
 * has exactly one of, or the single block of an answered or settled default.
 */
export function compactDefault(fallback: SlackCardMessage): SlackCardMessage {
  const blocks = fallback.blocks.filter((block) => eveControls(block).length > 0);
  return blocks.length === 0 ? fallback : { ...fallback, blocks };
}

/**
 * eve's controls anywhere in `value`, nested blocks included: each action ID with the value or
 * option values a click sends, sorted so order and nesting don't matter.
 */
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

/**
 * Sends `message`, and once more with eve's default when Slack refuses its content, unless the
 * default is the same message. Any other failure is thrown, since resending after a timeout could
 * duplicate a message that landed. A request without a default for this message, such as details
 * a renderer added, sends nothing the second time.
 */
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
