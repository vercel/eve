import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  // Each eval dispatches its own durable runs on one eval server. The 120 s
  // timeout leaves ample room for four concurrent evals, which take about 5 s
  // each run alone.
  maxConcurrency: 4,
  timeoutMs: 120_000,
});
