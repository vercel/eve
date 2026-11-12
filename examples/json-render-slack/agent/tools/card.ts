import { CardSpecError, toCard } from "@json-render/chat";
import { defineTool } from "eve/tools";

import { cardSpecSchema, SLACK_CARD_LIMITS } from "../lib/card-spec";

export default defineTool({
  description: [
    "Post a rich card in the conversation: tables, charts, key figures, images, and buttons.",
    "Use it when structured data reads better as a card than as prose.",
    "The spec is a flat map of elements. The root is a Card; group with Section;",
    "Field goes inside Fields; Button and LinkButton go inside Actions.",
    "Text content is markdown without headings. Each bar/line/area series has one value per category.",
    "A message holds at most one Table and two Charts.",
    "The card is shown to the user as you write it, so do not repeat its content in your reply.",
  ].join(" "),
  inputSchema: cardSpecSchema,
  label: { start: () => "Drawing a card" },
  async execute(spec) {
    try {
      // Channels render the card from the call's input; validating here lets the model fix a bad spec.
      toCard(spec, { limits: SLACK_CARD_LIMITS });
    } catch (error) {
      if (error instanceof CardSpecError) {
        throw new Error(
          `Invalid card spec. Fix these and call again:\n- ${error.issues.join("\n- ")}`,
        );
      }
      throw error;
    }
    return { posted: true };
  },
});
