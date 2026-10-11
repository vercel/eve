import { createOpenAI } from "@ai-sdk/openai";

type JudgeModel = ReturnType<ReturnType<typeof createOpenAI>["decisionModel"]>;

/** Shared fixture judge, independent of the agent matrix, until CI has access to Jev. */
export function e2eJudgeModel(): JudgeModel {
  return createOpenAI({
    apiKey: process.env.AI_GATEWAY_API_KEY,
    baseURL: "https://ai-gateway.vercel.sh/v1",
  }).decisionModel("openai/gpt-5.6-luna");
}
