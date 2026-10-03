import { z } from "#compiled/zod/index.js";
import { isAgentReasoningDefinition, isRuntimeLanguageModel } from "#internal/runtime-model.js";
import type { AgentReasoningDefinition, AgentStaticModelDefinition } from "#public/index.js";

import { DEPLOYED_OPTION_MOVED_MESSAGE } from "../config.js";

export const selfModificationConfigSchema = z
  .object({
    model: z
      .custom<AgentStaticModelDefinition>(
        (value) => typeof value === "string" || isRuntimeLanguageModel(value),
      )
      .optional(),
    reasoning: z.custom<AgentReasoningDefinition>(isAgentReasoningDefinition).optional(),
    local: z.object({ enabled: z.boolean().optional() }).optional(),
    // Kept only to reject the former combined mount with a migration message.
    deployed: z
      .custom<never>((value) => value === undefined, DEPLOYED_OPTION_MOVED_MESSAGE)
      .optional(),
  })
  .strict();
