import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  // code_mode dispatches durable runs; serialize so they are never starved
  // past the per-eval timeout.
  maxConcurrency: 1,
  timeoutMs: 120_000,
});
