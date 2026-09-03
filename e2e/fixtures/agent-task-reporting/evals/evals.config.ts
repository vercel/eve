import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  // Each eval launches three long-lived in-memory sandbox tasks. Running the
  // eight identical cases concurrently starves one of their wake streams.
  maxConcurrency: 1,
  timeoutMs: 240_000,
});
