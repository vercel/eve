import { defineEval } from "eve/evals";

import { requireMockModel } from "./mock-model";

const NOTICE = "The lobby closes early on Sunday.";

const mentions = (text: string) => (value: unknown) => JSON.stringify(value).includes(text);

export default defineEval({
  description:
    "A tool whose approval policy asks a person comes back from the MCP channel as an approval error, and never runs.",

  async test(t) {
    requireMockModel(t);
    const turn = await t.send(
      `Alice drafts the weekend notice for the front-desk board. MCP_PUBLISH "${NOTICE}"`,
    );
    turn.expectOk();

    turn.notEvent("interaction.opened");
    turn.calledTool("loopback__publish_notice", {
      count: 1,
      output: mentions("needs a person's approval, which this MCP channel cannot ask for"),
      status: "failed",
    });
    turn.calledTool("loopback__publish_notice", { count: 0 });
  },
});
