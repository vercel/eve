import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  // Each eval launches three background tasks. Serializing cases keeps their
  // wake streams independent of eval-runner contention.
  maxConcurrency: 1,
  timeoutMs: 240_000,
});
