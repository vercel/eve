import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "A correction during pending generation produces one corrected answer in the same turn.",
  timeoutMs: 120_000,
  async test(t) {
    if (process.env.EVE_E2E_MODEL !== "mock") {
      t.skip("Requires the deterministic model's pending-generation gate.");
    }
    const conversation = await t.session();
    const live = await conversation.start("Alice is preparing the 2026 report.");
    const started = await live.waitForEvent("step.started");
    const observedAt = Date.now();
    t.log(
      `Pending generation observed ${observedAt - Date.parse(started.meta.at)} ms after step.started.`,
    );
    const correction = await live.session.start("Alice corrected the report year to 2025.", {
      turnPolicy: "steer",
    });
    t.log(`Steering accepted ${Date.now() - observedAt} ms after observing pending generation.`);
    const result = await live.result();
    await correction.result();
    result.event("turn.started", { count: 1 });
    result.event("turn.completed", { count: 1 });
    result.event("message.received", { count: 2 });
    result.notEvent("turn.cancelled");
    result.notEvent("turn.failed");
    result.notEvent("step.failed");
    result.messageIncludes("Corrected 2025 report");
    await t.require(
      result.events,
      satisfies(
        (events: typeof result.events) =>
          !events.some(
            (event) =>
              event.type === "message.appended" && event.data.messageDelta.includes("Original"),
          ),
        "the superseded generation never publishes its answer",
      ),
    );
    t.succeeded();
  },
});
