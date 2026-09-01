import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  startingPoint: simpleProject,
  async interact({ send }) {
    await send(
      "Add a `refund_payment` tool that accepts a payment ID and a positive refund amount in US dollars, then returns a confirmation containing both values. Refunds below $100 should run without approval; refunds of $100 or more must require user approval before execution.",
    );
  },
});
