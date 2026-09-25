import { e2eJudgeModel } from "@eve-e2e/config";
import { defineEvalConfig } from "eve/evals";

import { startRegistryServer } from "./self-modification/registry-server";

export default defineEvalConfig({
  judge: { model: e2eJudgeModel() },
  maxConcurrency: 1,
  timeoutMs: 240_000,
  setup: startRegistryServer,
  async teardown(stop) {
    await stop?.();
  },
});
