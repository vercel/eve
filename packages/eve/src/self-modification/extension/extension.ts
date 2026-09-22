import { defineExtension } from "eve/extension";
import { z } from "zod";

import { isAgentReasoningDefinition, isRuntimeLanguageModel } from "#internal/runtime-model.js";
import type { AgentReasoningDefinition, AgentStaticModelDefinition } from "#public/index.js";
import type { GitHubCredentialProvider, SelfModificationAuthorization } from "../config.js";

export const selfModificationConfigSchema = z.object({
  model: z
    .custom<AgentStaticModelDefinition>(
      (value) => typeof value === "string" || isRuntimeLanguageModel(value),
    )
    .optional(),
  reasoning: z.custom<AgentReasoningDefinition>(isAgentReasoningDefinition).optional(),
  local: z.object({ enabled: z.boolean().optional() }).optional(),
  deployed: z
    .object({
      credentials: z
        .union([
          z.object({ pat: z.literal(true) }),
          z.custom<GitHubCredentialProvider>(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              "resolve" in value &&
              typeof value.resolve === "function",
          ),
        ])
        .optional(),
      source: z.object({
        git: z.object({ directory: z.string(), repository: z.string() }),
      }),
      target: z.object({ branch: z.string() }),
      authorize: z.custom<SelfModificationAuthorization>((value) => typeof value === "function"),
    })
    .optional(),
});

/** Extension mount configured with the same policy as the agent and sandbox. */
export default defineExtension({ config: selfModificationConfigSchema });
