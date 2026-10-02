import { isDeepStrictEqual } from "node:util";

import { defineEval } from "eve/evals";

import { SERVICE_ID } from "../fixture";
import { requireMockModel } from "./mock-model";

export default defineEval({
  description:
    "The agent calls one of its own tools through its MCP channel and gets the tool's exact structured output, run as the route-authenticated caller.",

  async test(t) {
    requireMockModel(t);
    const turn = await t.send(
      "Alice starts her shift and checks which account the kennel tools run as. MCP_WHOAMI",
    );
    turn.expectOk();

    turn.calledTool("loopback__whoami", {
      count: 1,
      output: (value) =>
        isDeepStrictEqual(value, { principalId: SERVICE_ID, principalType: "service" }),
    });
  },
});
