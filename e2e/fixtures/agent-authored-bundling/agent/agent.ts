import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { respond } from "./lib/mock-responder";

const base = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...base,
  model: mockModel(respond),
  modelContextWindowTokens: base.modelContextWindowTokens ?? 1_000_000,
});
