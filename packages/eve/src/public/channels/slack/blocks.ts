import { cardToSlackBlocks } from "#compiled/@chat-adapter/slack/blocks.js";
import { cardChildToFallbackText, type CardChild, type CardElement } from "#compiled/chat/index.js";

export type BlockKitBlock = Record<string, unknown>;

export function cardToBlocks(card: CardElement): BlockKitBlock[] {
  return cardToSlackBlocks({
    ...card,
    children: card.children.map(preserveLinkActionId),
  });
}

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

function preserveLinkActionId(child: CardChild): CardChild {
  if (child.type === "section") {
    return {
      ...child,
      children: child.children.map(preserveLinkActionId),
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
