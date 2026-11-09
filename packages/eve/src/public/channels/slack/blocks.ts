import { cardToSlackBlocks, type SlackCardChild } from "#compiled/@chat-adapter/slack/blocks.js";
import { cardChildToFallbackText } from "#compiled/chat/index.js";
import type { CardChild, CardElement } from "#public/channels/slack/cards.js";

/** A Slack Block Kit block emitted by {@link cardToBlocks}. */
export type BlockKitBlock = Record<string, unknown>;

/** Converts a Chat SDK card into Slack Block Kit blocks. */
export function cardToBlocks(card: CardElement): BlockKitBlock[] {
  return cardToSlackBlocks({
    ...card,
    children: card.children.map(toSlackCardChild),
  });
}

/** Creates the plain-text fallback used for notifications and accessibility. */
export function cardToFallbackText(card: CardElement): string {
  const lines: string[] = [];
  if (card.title) lines.push(card.title);
  if (card.subtitle) lines.push(card.subtitle);
  for (const child of card.children) {
    const text = cardChildToFallbackText(child);
    if (text) lines.push(text);
  }
  return lines.join("\n").trim();
}

function toSlackCardChild(child: CardChild): SlackCardChild {
  if (child.type === "section") {
    return {
      ...child,
      children: child.children.map(toSlackCardChild),
    };
  }
  if (child.type === "actions") {
    return {
      ...child,
      children: child.children.map((action) =>
        action.type === "link-button" && action.id === undefined
          ? { ...action, id: `link:${action.url}` }
          : action,
      ),
    };
  }
  return child;
}
