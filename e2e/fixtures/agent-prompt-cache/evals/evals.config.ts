import { defineEvalConfig } from "eve/evals";

// Each eval holds its own sessions and checks cache reuse only within them, so
// the three evals run together.
export default defineEvalConfig({ maxConcurrency: 3, timeoutMs: 240_000 });
