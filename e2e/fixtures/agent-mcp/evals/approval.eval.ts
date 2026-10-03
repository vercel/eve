import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { SERVICE_ID, USER_HEADER } from "../fixture";
import { requireMockModel } from "./mock-model";

const NOTICE = "Biscuit goes home on Friday at noon.";
/** eve's MCP `requestState`: `v1.<payload>.<mac>`, both base64url. */
const REQUEST_STATE = /v1\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/u;

const asAlice = { headers: { [USER_HEADER]: "alice" } };

/**
 * The MCP channel answers `input_required` for a tool whose approval policy
 * asks a person. eve's MCP connection relays it to the calling session's user
 * as an ordinary approval, holds the turn, and retries the call once she
 * approves. Over MCP the calling client answers its own approval, so the tool
 * runs as the loopback connection's service principal.
 */
export default defineEval({
  description:
    "An MCP approval asks the calling session's user, and the tool runs once after she approves.",
  timeoutMs: 180_000,

  async test(t) {
    requireMockModel(t);
    const parked = await t.send(
      `Alice asks the desk agent to post a pickup notice for Biscuit. MCP_PUBLISH "${NOTICE}"`,
      asAlice,
    );
    parked.event("input.requested", { count: 1 });
    parked.calledTool("loopback__publish_notice", { count: 0 });
    const request = parked.session.requireInputRequest({ toolName: "connection_execute" });

    const approved = await parked.session.respond(
      [{ optionId: "approve", requestId: request.requestId }],
      asAlice,
    );
    approved.expectOk();
    approved.calledTool("loopback__publish_notice", {
      count: 1,
      output: { by: SERVICE_ID, published: NOTICE },
    });

    await t.require(
      JSON.stringify([...parked.events, ...approved.events]),
      satisfies(
        (text: string) => !REQUEST_STATE.test(text),
        "no event carries the MCP requestState",
      ),
    );
  },
});
