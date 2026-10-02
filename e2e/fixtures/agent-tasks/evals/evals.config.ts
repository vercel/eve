import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  // Each eval waits on tasks that take ten to fifteen seconds, sometimes twice.
  timeoutMs: 240_000,
});
