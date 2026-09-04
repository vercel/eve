import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { createRedeployFixture, readEveVersion } from "@eve-e2e/config/redeploy";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { postChannel } from "./shared";

const OLD_EVE_VERSION = "0.30.8";
const ACTIVE_TURN_MESSAGE = "Please wait for cross-version follow-up.";
const FOLLOW_UP_TOKEN = "CROSS-VERSION-WIRE-OK";
const OLD_DEPLOYMENT_MARKER = "cross-version-eve-0-30-8";
const CURRENT_DEPLOYMENT_MARKER = "cross-version-eve-current";
const TOOL_NAME = "wait-for-cancellation";

type MessageResponse = { ok: boolean; sessionId?: string };

/** Exercises the published decoder, not a current decoder receiving an old version number. */
export default defineEval({
  description:
    "Session inbox: the current producer resumes an active eve@0.30.8 consumer through the durable hook.",
  tags: ["redeploy"],
  timeoutMs: 20 * 60_000,

  async test(t) {
    const fixture = await createRedeployFixture(t);
    const oldEvePackage = await realpath(resolve("node_modules", "historical-eve-0-30-8"));
    if ((await readEveVersion(oldEvePackage)) !== OLD_EVE_VERSION) {
      throw new Error(`Expected published eve@${OLD_EVE_VERSION}.`);
    }
    try {
      await fixture.deploy(oldEvePackage, OLD_DEPLOYMENT_MARKER);
      const sessionRef = crypto.randomUUID();
      const started = await postChannel<MessageResponse>(t.target, "/cross-version-webhook", {
        message: ACTIVE_TURN_MESSAGE,
        sessionRef,
      });
      await t.require(
        started,
        satisfies(
          (value: MessageResponse) => value.ok === true && typeof value.sessionId === "string",
          "eve@0.30.8 starts the durable session",
        ),
      );
      const sessionId = started.sessionId!;
      const activeTurn = t.target.watchTurn(sessionId);

      await activeTurn.waitForEvent("actions.requested", {
        data: {
          actions: (actions) =>
            actions.some((action) => action.kind === "tool-call" && action.toolName === TOOL_NAME),
        },
      });

      await fixture.deploy(fixture.currentPackage, CURRENT_DEPLOYMENT_MARKER);

      const replacement = await postChannel<MessageResponse>(t.target, "/cross-version-webhook", {
        message: `Reply with exactly ${FOLLOW_UP_TOKEN}.`,
        sessionRef,
        turnPolicy: "queue",
      });
      await t.require(
        replacement,
        satisfies(
          (value: MessageResponse) => value.ok === true && value.sessionId === sessionId,
          "the current producer targets the existing eve@0.30.8 session",
        ),
      );

      // eve@0.30.8 buffers a raw `send` during an active turn but predates
      // `turnPolicy: "steer"`. Settle the deliberately blocked turn through a
      // separate cancellation; the queued message must then become the next
      // turn if the old receiver decoded and retained it.
      await t.sleep(1_000);
      const cancellation = await activeTurn.cancel();
      await t.require(
        cancellation,
        satisfies(
          (value: { readonly sessionId?: string; readonly status: string }) =>
            value.status === "accepted" && value.sessionId === sessionId,
          "the current deployment cancels the active eve@0.30.8 turn",
        ),
      );

      const cancelled = await activeTurn.result();
      cancelled.event("turn.cancelled", { count: 1 });
      cancelled.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
      cancelled.notEvent("turn.failed");
      cancelled.notEvent("session.failed");

      const followUp = await t.target
        .watchTurn(sessionId, { startIndex: cancelled.events.length })
        .result();
      followUp.notEvent("turn.cancelled");
      followUp.notEvent("turn.failed");
      followUp.notEvent("session.failed");
      followUp.messageIncludes(FOLLOW_UP_TOKEN);

      t.succeeded();
    } finally {
      await fixture.restore();
    }
  },
});
