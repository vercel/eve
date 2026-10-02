import { isDeepStrictEqual } from "node:util";

import { defineEval } from "eve/evals";

import { SERVICE_ID, USER_HEADER } from "../fixture";
import { requireMockModel } from "./mock-model";

export default defineEval({
  description:
    "The agent calls one of its own tools through its MCP channel and gets the tool's exact structured output, run as the forwarded user rather than the forwarding service.",

  async test(t) {
    requireMockModel(t);
    const turn = await t.send(
      "Alice starts her shift and checks which account the kennel tools see her as. MCP_WHOAMI",
      { headers: { [USER_HEADER]: "alice" } },
    );
    turn.expectOk();

    turn.calledTool("loopback__whoami", {
      count: 1,
      output: (value) =>
        isDeepStrictEqual(value, {
          forwardedBy: SERVICE_ID,
          principalId: "alice",
          principalType: "user",
        }),
    });
  },
});
