import { setTimeout as sleep } from "node:timers/promises";

import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import { TOKEN } from "../agent/token-config.js";
import { mintToken } from "./token.js";

const outlive = () => sleep((TOKEN.lifetimeSeconds + 1) * 1000);

/**
 * Alice's session tokens expire after a few seconds. Her conversation spans
 * several lifetimes: a stubbed lookup, a note that waits for her approval, and
 * the runner's final stub check, each sent with a freshly minted token.
 */
export default defineEval({
  description: "targetAuth mints a fresh token for every request across an eval that outlives one.",
  timeoutMs: 120_000,
  async test(t) {
    const firstToken = mintToken();
    const session = await t.session({
      stubs: [
        { id: "ticket", tool: "lookup_ticket", outcome: { response: { marker: "STUBBED" } } },
      ],
    });

    const lookup = await session.send("Look up ticket T-1 and report its marker.");
    lookup.expectOk();
    lookup.calledTool("lookup_ticket", { output: { marker: "STUBBED" }, count: 1 });

    await outlive();
    const expired = await t.target.fetch("/eve/v1/info", {
      headers: { authorization: `Bearer ${firstToken}` },
    });
    await t.require(expired.status, equals(401));

    const asking = await session.send("Save a note on ticket T-1 that we called Alice.");
    const { interactionId } = asking.session.requireInteraction({ toolName: "save_note" });

    await outlive();
    const approved = await session.respond([{ optionId: "approve", interactionId }]);
    approved.expectOk();
    approved.calledTool("save_note", { output: { saved: true }, count: 1, status: "completed" });

    await outlive();
    t.succeeded();
  },
});
