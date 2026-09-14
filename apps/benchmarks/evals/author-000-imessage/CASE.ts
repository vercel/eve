import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";
import { imessageSetup } from "../../lib/setups/imessage.js";

const PHONE_NUMBER = "+15551234567";

export default defineAuthoringCase({
  startingPoint: simpleProject,
  setup: imessageSetup,
  async interact({ send }) {
    await send("Set up iMessage for this agent. I can provide a phone number if you need it.");
    await send(PHONE_NUMBER);
  },
});
