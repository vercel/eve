import { defineEval } from "eve/evals";

import { MODEL_CHOICE_SCENARIO, MODEL_CHOICE_SELECTED } from "../constants";

/**
 * `report-writer` lists `model: ["openai/gpt-5.4-mini", "openai/gpt-5.4"]`.
 * The parent picks the non-default choice through the tool's `model` field,
 * and every step of the child session must run on that model.
 */
export default defineEval({
  description: "A parent selects one of a local subagent's listed models for a new child.",
  async test(t) {
    const parent = await t.send(MODEL_CHOICE_SCENARIO);
    parent.expectOk();
    const called =
      parent.events.find(
        (event) => event.type === "subagent.called" && event.data.name === "report-writer",
      ) ??
      (await t.target
        .watchTurn(parent.sessionId, { startIndex: parent.session.state.streamIndex })
        .waitForEvent("subagent.called", { data: { name: "report-writer" } }));
    if (called?.type !== "subagent.called") throw new Error("report-writer was not called.");

    const child = await t.target.watchTurn(called.data.childSessionId).result();
    child.expectOk();
    child.eventsSatisfy(`every child step runs on ${MODEL_CHOICE_SELECTED}`, (events) => {
      const steps = events.filter((event) => event.type === "step.started");
      return (
        steps.length > 0 && steps.every((event) => event.data.modelId === MODEL_CHOICE_SELECTED)
      );
    });
  },
});
