import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  judge: { model: "typesafe-ai/jev" },
  maxConcurrency: 4,
  timeoutMs: 180_000,
});
