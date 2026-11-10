import { CardSpecError, toCard } from "@json-render/chat";
import { cardToFallbackText, type CardElement } from "eve/channels/slack";
import { defineTool } from "eve/tools";

import {
  CARD_LIMITS,
  CARD_MAX_BLOCKS,
  CARD_MEDIA_TYPE,
  cardComponents,
  cardSpecSchema,
} from "../lib/spec";

export default defineTool({
  description: [
    "Show structured data to the user as a card: tables, charts, key figures, images, and links.",
    "Use it when data reads better as a card than as prose.",
    "The spec is a flat map of elements. The root is a Card; group with Section;",
    "Field goes inside Fields; LinkButton goes inside Actions.",
    "Text content is markdown without headings. Each bar/line/area series has one value per category.",
    "A card holds at most one Table and two Charts.",
    "The user sees the card as you write it, so don't repeat its content in your reply.",
  ].join(" "),
  inputSchema: cardSpecSchema,
  label: { start: () => "Drawing a card" },
  replyPart: {
    kind: "card",
    mediaType: CARD_MEDIA_TYPE,
    streamInput: true,
    build(spec) {
      let card: CardElement;
      try {
        // json-render types cards with Chat SDK's declarations; eve declares its own copy.
        card = toCard(spec, { components: cardComponents, limits: CARD_LIMITS }) as CardElement;
      } catch (error) {
        if (!(error instanceof CardSpecError)) throw error;
        throw invalidSpec(error.issues);
      }
      // Past its limit, eve's Slack blocks drop the card's end without an error.
      const blocks = blockCount(card);
      if (blocks > CARD_MAX_BLOCKS) {
        throw invalidSpec([
          `the card makes ${blocks} Slack blocks, and a message holds at most ${CARD_MAX_BLOCKS}; merge Text elements or trim the card`,
        ]);
      }
      return { fallbackText: cardToFallbackText(card), value: spec };
    },
  },
  async execute() {
    return { shown: true };
  },
});

/** The Slack blocks `card` makes: one each for its header parts and children, with sections flattened. */
function blockCount(card: CardElement): number {
  const header = [card.title, card.subtitle, card.imageUrl].filter(Boolean).length;
  const count = (children: CardElement["children"]): number =>
    children.reduce(
      (total, child) => total + (child.type === "section" ? count(child.children) : 1),
      0,
    );
  return header + count(card.children);
}

function invalidSpec(issues: readonly string[]): Error {
  return new Error(`Invalid card spec. Fix these and call again:\n- ${issues.join("\n- ")}`);
}
