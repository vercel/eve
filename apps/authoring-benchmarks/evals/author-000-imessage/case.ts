import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";
import { imessageSetup } from "../../lib/setups/imessage.js";

const PHONE_NUMBER = "+15551234567";

export default defineAuthoringCase({
  startingPoint: simpleProject,
  setup: imessageSetup,
  async interact({ send }) {
    const firstTurn = await send("Let me talk to this agent via iMessage.");
    if (!/phone number|imessage number|number should/i.test(firstTurn.text)) {
      throw new Error(
        `Expected the agent to ask for the user's phone number on its first turn. Received: ${JSON.stringify(firstTurn.text)}`,
      );
    }
    await send(PHONE_NUMBER);
  },
});
