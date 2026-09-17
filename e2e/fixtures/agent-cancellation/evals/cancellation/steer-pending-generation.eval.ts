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
    const live = await t.start("Alice is preparing the 2026 report.");
    await live.waitForEvent("step.started");
    const correction = await live.session.start("Alice corrected the report year to 2025.", {
      turnPolicy: "steer",
    });
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
