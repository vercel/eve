import type { LanguageModel } from "ai";
import { defineExtension } from "eve/extension";
import type { ApprovalPolicy } from "eve/tools/approval";
import { z } from "zod";

import type { GoalJudge } from "./lib/judge.ts";

export type { GoalJudge, GoalJudgeInput, GoalVerdict } from "./lib/judge.ts";
export type { Goal, GoalStatus } from "./lib/state.ts";

const fn = <T>() => z.custom<T>((value) => typeof value === "function");

/** An AI SDK language model instance, checked by shape as eve checks an agent's model. */
const languageModel = z.custom<LanguageModel>((value) => {
  if (typeof value !== "object" || value === null) return false;
  const model = value as Record<string, unknown>;
  return (
    typeof model.specificationVersion === "string" &&
    typeof model.provider === "string" &&
    typeof model.modelId === "string" &&
    typeof model.doGenerate === "function" &&
    typeof model.doStream === "function"
  );
}, "Expected a model ID or an AI SDK language model instance.");

export default defineExtension({
  config: z.object({
    /**
     * The model the default judge asks after every turn: a model ID routed through AI
     * Gateway, or a model instance such as `openai("gpt-6-luna-fast")` from
     * `eve/models/openai`. Ignored when `judge` is set.
     */
    model: z.union([z.string().min(1), languageModel]).default("openai/gpt-6-luna-fast"),
    /** Replaces the default judge, for example to verify with your own checks. */
    judge: fn<GoalJudge>().optional(),
    /** Continuations a goal may run before it pauses. */
    maxRuns: z.number().int().positive().default(50),
    /**
     * Model spend, in US dollars, the agent's turns may add before the goal pauses. The judge's
     * own calls aren't counted. Unlimited when unset.
     */
    maxCostUsd: z.number().positive().optional(),
    /**
     * Approval for the model's `goal__set` calls, such as `always()` from `eve/tools/approval`.
     * The model sets goals without approval when unset.
     */
    setApproval: fn<ApprovalPolicy<{ readonly objective: string }>>().optional(),
  }),
});
