import { defineEval } from "eve/evals";
import { loadJson } from "eve/evals/loaders";

const INITIAL_TARGET = "005INITIALTARGET";
const CORRECTED_TARGET = "005CORRECTEDTARGET";
const INCIDENT_MODEL = "anthropic/claude-opus-4.8";

interface ModelRegistry {
  readonly models: readonly { readonly id: string }[];
}

const registry = (await loadJson("../../matrix.json")) as ModelRegistry;
const models = [...new Set([...registry.models.map(({ id }) => id), INCIDENT_MODEL])];

export default models.map((model) =>
  defineEval({
    tags: ["real-model"],
    description: `${model}: a newer user correction supersedes the model-visible pending-approval projection.`,
    metadata: { model },
    timeoutMs: 180_000,
    async test(t) {
      const initial = await t.send(
        [
          `[pending-approval-projection-model: ${model}]`,
          `Present a change plan targeting user id ${INITIAL_TARGET} by calling request-change-confirmation.`,
        ].join("\n"),
      );
      initial.event("step.started", { data: { modelId: model }, count: 1 });
      initial.calledTool("request-change-confirmation", {
        status: "pending",
        input: { targetUserId: INITIAL_TARGET },
        count: 1,
      });

      const corrected = await t.send(
        [
          "I am the original requester and confirm the intended outcome:",
          `set the target to explicit user id ${CORRECTED_TARGET}, not ${INITIAL_TARGET}.`,
          "The correction is authorized. Please revise and submit the plan now.",
        ].join("\n"),
      );

      corrected.expectOk();
      corrected.calledTool("emit-revised-change-plan", {
        input: { targetUserId: CORRECTED_TARGET },
        output: { emitted: true, targetUserId: CORRECTED_TARGET },
        count: 1,
      });
      corrected.calledTool("request-change-confirmation", { count: 0 });
      corrected.calledTool("ask_question", { status: "pending", count: 0 });
    },
  }),
);
