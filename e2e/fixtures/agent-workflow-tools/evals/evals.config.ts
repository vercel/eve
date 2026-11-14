import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  // Each eval dispatches its own durable runs on one eval server. The 120 s
  // timeout leaves ample room for four concurrent evals, which take about 5 s
  // each run alone.
  // e2e-vercel sets EVE_E2E_EVAL_CONCURRENCY: there each eval's work runs on
  // the deployment's functions rather than on the runner, so more run at once.
  maxConcurrency: Number(process.env.EVE_E2E_EVAL_CONCURRENCY ?? 4),
  timeoutMs: 120_000,
});
