import { defineEval } from "eve/evals";

import { DESTRUCTIVE_DENIAL } from "../fixture";
import { requireMockModel } from "./mock-model";

const mentions = (text: string) => (value: unknown) => JSON.stringify(value).includes(text);

export default defineEval({
  description:
    "A connection approval policy reads the tool annotations the MCP server declared and denies a tool marked destructive before it runs.",

  async test(t) {
    requireMockModel(t);
    const cancelled = await t.send(
      "Alice asks the front desk to stop yesterday's kennel report run. MCP_CANCEL",
    );
    cancelled.expectOk();
    cancelled.notEvent("input.requested");
    cancelled.calledTool("loopback__agent_cancel", {
      count: 1,
      output: mentions(DESTRUCTIVE_DENIAL),
      status: "failed",
    });
  },
});
