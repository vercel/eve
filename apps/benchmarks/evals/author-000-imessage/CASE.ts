import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";
import { imessageSetup } from "../../lib/setups/imessage.js";

const PHONE_NUMBER = "+15551234567";

export default defineAuthoringCase({
  startingPoint: simpleProject,
  setup: imessageSetup,
  async interact({ send }) {
    const firstTurn = await send(
      "Set up iMessage for this agent. I can provide a phone number if you need it.",
    );
    if (!asksForPhoneNumber(firstTurn.text)) {
      throw new Error(
        `Expected the agent to ask for the user's phone number on its first turn. Received: ${JSON.stringify(firstTurn.text)}`,
      );
    }
    await send(PHONE_NUMBER);
  },
});

function asksForPhoneNumber(text: string): boolean {
  return /\b(?:what(?:'s| is)?|which)\s+(?:is\s+)?(?:your\s+)?(?:phone|imessage)\s+number\b|\b(?:please|can|could|would)\s+(?:you\s+)?(?:provide|share|enter|give|tell me)\b[\s\S]{0,40}\b(?:your\s+)?(?:phone|imessage)\s+number\b|\b(?:i\s+)?(?:need|require)\s+(?:your\s+)?(?:phone|imessage)\s+number\b/i.test(
    text,
  );
}
