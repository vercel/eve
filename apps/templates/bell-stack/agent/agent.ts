import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";

export default defineAgent({
  model: openai.responses(process.env.BELL_MODEL ?? "gpt-5.6-sol"),
  build: {
    externalDependencies: [
      "@1password/sdk",
      "@browserbasehq/sdk",
      "@browserbasehq/stagehand",
      "playwright-core",
      "pg",
    ],
  },
  limits: { sessionTimeoutMs: 24 * 60 * 60 * 1_000 },
});
