import { latestTaskResult, playScript } from "@eve-e2e/config/mock-script";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

import { STAGER_INTERIM_MESSAGE } from "../../../task-scenario-text.ts";

/**
 * Starts a staging task, ends its step with text while the task works, and
 * replies with the result once it arrives. The text step holds the child's
 * turn, which a child session never presents as a waiting boundary.
 */
function respond(request: MockModelRequest): MockModelResponse | string {
  return playScript(
    request,
    [{ id: "child-stage", input: () => ({ service: "api" }), name: "stage_deploy" }],
    () => {
      const result = latestTaskResult(request, "stage_deploy");
      if (result === undefined) return STAGER_INTERIM_MESSAGE;
      return `WORKFLOW-CHILD-STAGED ${result}`;
    },
  );
}

export default defineAgent({
  description: "Stage a service deploy for the parent and report the staged plan.",
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
