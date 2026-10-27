import type { LanguageModel } from "ai";
import { defineExtension } from "eve/extension";
import { z } from "zod";

import type { GoalJudge } from "./lib/judge.ts";

export type { GoalJudge, GoalJudgeInput, GoalVerdict } from "./lib/judge.ts";
export type { Goal, GoalStatus } from "./lib/state.ts";

const fn = <T>() => z.custom<T>((value) => typeof value === "function");

export default defineExtension({
  config: z.object({
    /**
     * The model the default judge asks after every turn: a model ID routed through AI
     * Gateway, or a model instance such as `openai("gpt-6-luna-fast")` from
     * `eve/models/openai`. Ignored when `judge` is set.
     */
    model: z
      .union([z.string().min(1), z.custom<LanguageModel>((value) => typeof value === "object")])
      .default("openai/gpt-6-luna-fast"),
    /** Replaces the default judge, for example to verify with your own checks. */
    judge: fn<GoalJudge>().optional(),
    /** Continuations a goal may run before it pauses. */
    maxRuns: z.number().int().positive().default(50),
    /** Model spend, in US dollars, a goal may add before it pauses. Unlimited when unset. */
    maxCostUsd: z.number().positive().optional(),
  }),
});
