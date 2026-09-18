import { access } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { runPnpmCommand } from "#internal/testing/run-pnpm-command.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";

const scenarioApp = useScenarioApp();

it("builds an agent and child with Gateway and provider evaluation models from packed eve", async () => {
  const app = await scenarioApp({
    name: "ai-models",
    installDependencies: true,
    files: {
      "agent/instructions.md": "Help Alice review the export incident.",
      "agent/evaluation.ts": `import type { Experimental_EvaluationModel } from "ai";
export const evaluationModel = {
  specificationVersion: "v4",
  provider: "fixture",
  modelId: "fixture-evaluator",
  supportedQuestionTypes: ["choice"],
  async doEvaluate() { throw new Error("Build must not evaluate models."); },
} satisfies Exclude<Experimental_EvaluationModel, string>;`,
      "agent/agent.ts": `import { defineAgent } from "eve";
import { auto } from "eve/models";
import { anthropic } from "eve/models/anthropic";
export default defineAgent({ model: auto({ options: { "openai/gpt-5.6-sol": "Investigations", my_secret_model: { model: anthropic("sonnet-5"), reasoning: "low", description: "Routine work" } } }) });`,
      "agent/tools/classify.ts": `import { defineTool } from "eve/tools";
import { evaluate } from "eve/ai";
export default defineTool({
  description: "Classify an incident",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const result = await evaluate({
      state: { incident: "Alice needs an export summary." },
      questions: { category: { type: "choice", instructions: "Choose a category.", criteria: { routine: "Routine work", investigation: "Investigation" } } },
      abortSignal: ctx.abortSignal,
    });
    return result.answers.category.choice;
  },
});`,
      "agent/subagents/worker/instructions.md": "Review the assigned evidence.",
      "agent/subagents/worker/agent.ts": `import { defineAgent } from "eve";
import { auto } from "eve/models";
import { anthropic } from "eve/models/anthropic";
import { evaluationModel } from "../../evaluation";
export default defineAgent({ description: "Review evidence", model: auto({ model: evaluationModel, options: { reviewer: { model: anthropic("sonnet-5"), reasoning: "low", description: "Investigations" } } }) });`,
    },
  });

  const built = await runPnpmCommand({
    args: ["exec", "eve", "build"],
    cwd: app.appRoot,
    env: {
      ...process.env,
      AI_GATEWAY_API_KEY: "",
      VERCEL_OIDC_TOKEN: "",
    },
  });
  expect(built.stdout).toContain("built output");
  await access(join(app.appRoot, ".output/server/index.mjs"));
  await expect(access(join(app.appRoot, "node_modules/eve/src"))).rejects.toThrow();
});
