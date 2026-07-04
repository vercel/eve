import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export const ECHO_LIMIT_TOKEN = "SUBAGENT_LIMIT_ECHO_CHILD_OK";

export default defineAgent({
  description:
    "Deterministic echo subagent for subagent limit e2e coverage. It returns a fixed marker.",
  model: mockModel(ECHO_LIMIT_TOKEN),
  modelContextWindowTokens: 1_000_000,
});
