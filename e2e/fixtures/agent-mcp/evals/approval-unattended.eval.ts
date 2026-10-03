import { defineEval } from "eve/evals";

import { USER_HEADER } from "../fixture";
import { requireMockModel } from "./mock-model";

const NOTICE = "The lobby closes early on Sunday.";
const CANNOT_ASK =
  "loopback__publish_notice needs the user to approve it, but this session cannot ask anyone, such as a scheduled run.";

const mentions = (text: string) => (value: unknown) => JSON.stringify(value).includes(text);

/**
 * A session started without `capabilities.requestInput` (how schedules and
 * other unattended callers run) has nobody to relay an MCP approval to. The
 * eval client cannot set capabilities, so the session is created on the eve
 * channel's session route directly.
 */
export default defineEval({
  description:
    "A session that cannot ask anyone fails an MCP approval closed with a clear message, and the tool never runs.",

  async test(t) {
    requireMockModel(t);
    const response = await t.target.fetch("/eve/v1/session", {
      body: JSON.stringify({
        capabilities: { requestInput: false },
        message: `Alice's overnight routine posts the weekend notice. MCP_PUBLISH "${NOTICE}"`,
      }),
      headers: { "content-type": "application/json", [USER_HEADER]: "alice" },
      method: "POST",
    });
    const created = (await response.json()) as { readonly sessionId?: string };
    if (!response.ok || created.sessionId === undefined) {
      throw new Error(`Creating the session failed (${String(response.status)}).`);
    }

    const turn = (await t.target.watchTurn(created.sessionId).result()).expectOk();
    turn.notEvent("input.requested");
    turn.calledTool("loopback__publish_notice", {
      count: 1,
      output: mentions(CANNOT_ASK),
      status: "failed",
    });
    turn.calledTool("loopback__publish_notice", { count: 0 });
  },
});
