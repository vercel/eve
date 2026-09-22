import { defineEval } from "eve/evals";
import { nestedBackgroundCompletion } from "../nested-background.js";

export default defineEval({
  tags: ["real-model"],
  timeoutMs: 240_000,
  description:
    "A local subagent yields with nested work pending and completes its caller once with the final result.",
  test: (t) => nestedBackgroundCompletion(t, "local-detector"),
});
