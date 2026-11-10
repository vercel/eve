import { defineEval } from "eve/evals";

import { SAY, aliceSession, asAlice } from "../helpers.ts";

/**
 * In a session with only Alice, the mismatch approval never asks, and her own token is handed
 * out without confirmation.
 */
export default defineEval({
  description:
    "A session with one person is never asked by mismatch approvals or the caller-confirmation default.",
  tags: ["hitl", "approval", "multiplayer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);

    const shared = (await session.send(SAY.sharedChange, asAlice)).expectOk();
    shared.notEvent("interaction.opened");
    shared.calledTool("shared-change", {
      status: "completed",
      output: { actor: "alice" },
      count: 1,
    });

    const token = (await session.send(SAY.aliceConfirmsToken, asAlice)).expectOk();
    token.notEvent("interaction.opened");
    token.calledTool("caller-token", {
      status: "completed",
      output: { token: "release-token:alice" },
      count: 1,
    });
  },
});
