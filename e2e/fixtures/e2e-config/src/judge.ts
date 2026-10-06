import { createOpenAI } from "@ai-sdk/openai";

type JudgeModel = ReturnType<ReturnType<typeof createOpenAI>["decisionModel"]>;

/**
 * Shared fixture judge, independent of the agent matrix, until CI has access to Jev.
 * `EVE_E2E_JUDGE_MODEL` lets the benchmark workflow pin the judge from e2e/benchmark.json.
 */
export function e2eJudgeModel(): JudgeModel {
  return createOpenAI({
    apiKey: process.env.AI_GATEWAY_API_KEY,
    baseURL: "https://ai-gateway.vercel.sh/v1",
  }).decisionModel(process.env.EVE_E2E_JUDGE_MODEL ?? "openai/gpt-5.6-luna");
}
