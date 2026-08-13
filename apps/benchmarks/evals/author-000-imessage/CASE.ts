import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";
import { imessageSetup } from "../../lib/setups/imessage.js";

const PHONE_NUMBER = "+447700900123";
const PHONE_NUMBER_QUESTION =
  /(?:what|which|provide|share|send|need)[^.!?\n]{0,100}(?:phone|imessage)[^.!?\n]{0,50}number|(?:phone|imessage)[^.!?\n]{0,50}number[^.!?\n]{0,100}(?:use|receive|register|provide|share|send|need)|(?:blocked|waiting)[^.!?\n]{0,120}(?:phone|imessage)[^.!?\n]{0,50}number/i;

export default defineAuthoringCase({
  startingPoint: simpleProject,
  setup: imessageSetup,
  async interact({ send }) {
    const firstTurn = await send("Let me talk to this agent via iMessage.");
    if (!PHONE_NUMBER_QUESTION.test(firstTurn.text)) {
      throw new Error(
        `Expected the agent to ask for the user's phone number on its first turn. Received: ${JSON.stringify(firstTurn.text)}`,
      );
    }
    await send(PHONE_NUMBER);
  },
});
