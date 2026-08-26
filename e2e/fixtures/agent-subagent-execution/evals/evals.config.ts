import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  maxConcurrency: 1,
  timeoutMs: 120_000,
});
