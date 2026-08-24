import { z } from "#compiled/zod/index.js";

import { jsonObjectSchema } from "#shared/json-schemas.js";
import type { JsonObject } from "#shared/json.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import {
  agentSourceCompositionSchema,
  type AgentSourceComposition,
  type CompiledSubagentSource,
  compiledSubagentSourceSchema,
} from "#compiler/source-composition.js";
import {
  type CompiledModuleBinding,
  compiledModuleBindingSchema,
} from "#compiler/module-binding.js";

export interface CompiledDynamicSubagentDefinition extends Readonly<ModuleSourceRef> {
  readonly build?: {
    readonly externalDependencies?: readonly string[];
  };
  readonly eventNames: readonly string[];
}

/**
 * Remote subagent entry owned by one compiled agent node manifest. Like
 * channels, remote subagents are node-local manifest entries rather than a
 * separate graph-level list.
 */
export type CompiledRemoteAgentNode = Readonly<
  CompiledSubagentSource & {
    bindings: Readonly<Record<string, CompiledModuleBinding>>;
    configResolver: ModuleSourceRef;
    description: string;
    outputSchema?: JsonObject;
    path: string;
    sourceComposition: AgentSourceComposition;
    // Absent when the definition's `url` is a function the runtime resolves.
    url?: string;
  }
>;

/**
 * Zod schema for one compiled remote subagent entry.
 */
export const compiledRemoteAgentNodeSchema: z.ZodType<CompiledRemoteAgentNode> = z
  .object({
    ...compiledSubagentSourceSchema.shape,
    bindings: z.record(z.string(), compiledModuleBindingSchema).readonly(),
    configResolver: z
      .object({
        exportName: z.string().optional(),
        logicalPath: z.string(),
        sourceId: z.string(),
        sourceKind: z.literal("module"),
      })
      .strict(),
    description: z.string(),
    outputSchema: jsonObjectSchema.optional(),
    path: z.string(),
    sourceComposition: agentSourceCompositionSchema,
    url: z.string().min(1).optional(),
  })
  .strict();
