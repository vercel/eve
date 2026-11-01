import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "/release calls the release tool from the harness, waits for approval, then settles.",
  timeoutMs: 120_000,
  async test(t) {
    const parked = await t.send("/release 1.2");
    const approval = parked.session.requireInteraction({ toolName: "release" });

    const resumed = await parked.session.respond([
      { interactionId: approval.interactionId, optionId: "approve" },
    ]);

    resumed.expectOk();
    resumed.messageIncludes("Released 1.2");
    resumed.session.event("model.requested", { count: 0 });
    t.succeeded();
  },
});
