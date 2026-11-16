import { defineEval } from "eve/evals";

/** Shared with `agent/agent.ts`, which holds a model call whose message names it. */
const HELD_MODEL_CALL = "HELD-MODEL-CALL";
/** Well inside the agent's 1.5 s hold on the model call. */
const INTERRUPT_AFTER_MS = 300;

const recordRequest = (marker: string) =>
  `${HELD_MODEL_CALL} Alice asks you to record-request with marker "${marker}".`;

/**
 * Alice cancels her first two requests while the model is still thinking about each, then
 * redirects the third. Each interrupt must stop the model call before it asks to record the
 * request, on later turns as on the first (vercel/eve#6496).
 */
export default defineEval({
  description: "A cancel or steer stops a pending model call on any turn, before its tools run.",
  timeoutMs: 120_000,
  async test(t) {
    if (process.env.EVE_E2E_MODEL !== "mock") {
      t.skip("Requires the deterministic model's held model call.");
    }
    const session = await t.session();

    for (const turn of ["first", "second"]) {
      const live = await session.start(recordRequest(`cancel-${turn}`));
      await live.waitForEvent("model.started");
      await new Promise((resolve) => setTimeout(resolve, INTERRUPT_AFTER_MS));
      await live.cancel();
      const cancelled = await live.result();
      cancelled.event("model.settled", { count: 1, data: { outcome: "interrupted" } });
      cancelled.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
      cancelled.notEvent("call.requested");
    }

    const live = await session.start(recordRequest("steer-third"));
    await live.waitForEvent("model.started");
    await new Promise((resolve) => setTimeout(resolve, INTERRUPT_AFTER_MS));
    const correction = await session.start("Alice changed her mind: just say hello.", {
      turnPolicy: "steer",
    });
    const steered = await live.result();
    await correction.result();
    steered.event("turn.settled", { count: 1, data: { outcome: "completed" } });
    steered.event("delivery.consumed", { count: 2 });
    steered.notEvent("call.requested");
    steered.messageIncludes("Alice changed her mind");
    t.succeeded();
  },
});
