import { defineEvalConfig } from "eve/evals";

// Bounds each eval, as agent-prompt-cache does for its long real-model turns.
export default defineEvalConfig({ timeoutMs: 240_000 });
