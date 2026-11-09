import { CardSpecError, toCard } from "@json-render/chat";
import { cardToFallbackText, type CardElement } from "eve/channels/slack";
import { defineTool } from "eve/tools";

import { CARD_LIMITS, CARD_MEDIA_TYPE, cardComponents, cardSpecSchema } from "../lib/spec";

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
      try {
        const card = toCard(spec, { components: cardComponents, limits: CARD_LIMITS });
        // json-render types cards with Chat SDK's declarations; eve declares its own copy.
        return { fallbackText: cardToFallbackText(card as CardElement), value: spec };
      } catch (error) {
        if (!(error instanceof CardSpecError)) throw error;
        throw new Error(
          `Invalid card spec. Fix these and call again:\n- ${error.issues.join("\n- ")}`,
        );
      }
    },
  },
  async execute() {
    return { shown: true };
  },
});
