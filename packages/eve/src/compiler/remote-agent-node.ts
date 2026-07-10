import { z } from "#compiled/zod/index.js";

import { jsonObjectSchema } from "#shared/json-schemas.js";
import type { JsonObject } from "#shared/json.js";
import type { Node } from "#shared/node.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

/**
 * Remote subagent entry owned by one compiled agent node manifest. Like
 * channels, remote subagents are node-local manifest entries rather than a
 * separate graph-level list.
 */
export type CompiledRemoteAgentNode = Readonly<
  ModuleSourceRef &
    Node & {
      description: string;
      entryPath: string;
      name: string;
      outputSchema?: JsonObject;
      path: string;
      rootPath: string;
      // Absent when the definition's `url` is a function the runtime resolves.
      url?: string;
    }
>;

/**
 * Zod schema for one compiled remote subagent entry.
 */
export const compiledRemoteAgentNodeSchema: z.ZodType<CompiledRemoteAgentNode> = z
  .object({
    description: z.string(),
    entryPath: z.string(),
    exportName: z.string().optional(),
    logicalPath: z.string(),
    name: z.string(),
    nodeId: z.string(),
    outputSchema: jsonObjectSchema.optional(),
    path: z.string(),
    rootPath: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
    url: z.string().optional(),
  })
  .strict();
