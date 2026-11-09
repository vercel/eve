import { createOpenAI } from "@ai-sdk/openai";
import { Experimental_DecisionLanguageModel } from "@ai-sdk/provider-utils/experimental-decision";

/**
 * Shared fixture judge, independent of the agent matrix, until CI has access to Jev.
 * It adapts the Responses API into decisions because the Gateway serves this model as a
 * language model, not on OpenAI's `/decisions` endpoint that `decisionModel()` now calls.
 */
export function e2eJudgeModel(): Experimental_DecisionLanguageModel {
  const openai = createOpenAI({
    apiKey: process.env.AI_GATEWAY_API_KEY,
    baseURL: "https://ai-gateway.vercel.sh/v1",
  });
  return new Experimental_DecisionLanguageModel({
    model: openai.responses("openai/gpt-5.6-luna"),
    provider: "openai.decision",
  });
}
