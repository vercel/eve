import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  judge: { model: "openai/gpt-5.6-luna" },
  maxConcurrency: 1,
  timeoutMs: 240_000,
});
