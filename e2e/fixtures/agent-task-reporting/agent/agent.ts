import { e2eAgentConfig } from "@eve-e2e/config";
import { gateway, wrapLanguageModel } from "ai";
import { defineAgent } from "eve";

import { reportingMiddleware } from "./lib/reporting-model.js";

const base = e2eAgentConfig();

export default defineAgent({
  ...base,
  // Wrapped Gateway handles do not resolve through eve's catalog lookup.
  // Both comparison arms use this fixture budget, well above the short cases.
  modelContextWindowTokens: 128_000,
  model: wrapLanguageModel({
    model: typeof base.model === "string" ? gateway(base.model) : base.model,
    middleware: reportingMiddleware,
  }),
});
