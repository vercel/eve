import { createOpenAI } from "@ai-sdk/openai";
import type { EveEvalJudgeConfig } from "eve/evals";

/** Shared fixture judge, independent of the agent matrix, until CI has access to Jev. */
export function e2eJudgeModel(): Exclude<EveEvalJudgeConfig["model"], string | undefined> {
  return createOpenAI({
    apiKey: process.env.AI_GATEWAY_API_KEY,
    baseURL: "https://ai-gateway.vercel.sh/v1",
  }).evaluationModel("openai/gpt-5.6-luna");
}
