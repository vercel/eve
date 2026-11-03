import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

import { AUDIENCE_HEADER } from "../fixture";

const mentions = (text: string) => (value: unknown) => JSON.stringify(value).includes(text);

export default defineEval({
  description:
    "In a conversation visible outside its participants, reading Alice's private notes is denied with the audience reason.",

  async test(t) {
    requireMockModel(t);
    const turn = await t.send("PRIVACY-NOTES Alice asks in #general for this week's notes.", {
      headers: { [AUDIENCE_HEADER]: "public" },
    });

    turn.expectOk();
    turn.notEvent("interaction.opened");
    turn.calledTool("notion_search", {
      count: 1,
      output: mentions("This conversation is visible outside its participants"),
      status: "rejected",
    });
  },
});
