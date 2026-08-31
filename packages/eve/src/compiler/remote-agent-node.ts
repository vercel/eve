import { z } from "#compiled/zod/index.js";

import { jsonObjectSchema } from "#shared/json-schemas.js";
import type { JsonObject } from "#shared/json.js";
import type { Node } from "#shared/node.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { AgentSourceOwner, CompiledModuleBinding } from "#compiler/source-graph.js";

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
  ModuleSourceRef &
    Node & {
      description: string;
      backing: { readonly kind: "resource"; readonly sourcePath: string };
      binding: CompiledModuleBinding;
      entryPath: string;
      name: string;
      owner: AgentSourceOwner;
      parentNodeId: string;
      outputSchema?: JsonObject;
      path: string;
      rootPath: string;
      // Absent when the definition's `url` is a function the runtime resolves.
      url?: string;
      workspaceMember?: {
        readonly description?: string;
        readonly name: string;
        readonly path: string;
      };
    }
>;

/**
 * Zod schema for one compiled remote subagent entry.
 */
export const compiledRemoteAgentNodeSchema: z.ZodType<CompiledRemoteAgentNode> = z
  .object({
    backing: z.object({ kind: z.literal("resource"), sourcePath: z.string() }).strict(),
    binding: z
      .object({
        backing: z.discriminatedUnion("kind", [
          z
            .object({
              externalDependencies: z.array(z.string()).readonly(),
              extensionScope: z
                .object({ namespace: z.string(), sourceRoot: z.string() })
                .strict()
                .optional(),
              kind: z.literal("filesystem"),
              sourcePath: z.string(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("programmatic"),
              moduleId: z.string(),
              registryId: z.string(),
              revision: z.string(),
              semanticRevision: z.string().optional(),
            })
            .strict(),
        ]),
        logicalPath: z.string(),
        owner: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("application") }).strict(),
          z.object({ feature: z.string(), kind: z.literal("framework") }).strict(),
          z
            .object({
              kind: z.literal("extension"),
              namespace: z.string(),
              packageName: z.string(),
            })
            .strict(),
        ]),
        usage: z.object({ compile: z.boolean(), runtimeEntry: z.boolean() }).strict(),
      })
      .strict(),
    description: z.string(),
    entryPath: z.string(),
    exportName: z.string().optional(),
    logicalPath: z.string(),
    name: z.string(),
    nodeId: z.string(),
    owner: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("application") }).strict(),
      z.object({ feature: z.string(), kind: z.literal("framework") }).strict(),
      z
        .object({ kind: z.literal("extension"), namespace: z.string(), packageName: z.string() })
        .strict(),
    ]),
    parentNodeId: z.string(),
    outputSchema: jsonObjectSchema.optional(),
    path: z.string(),
    rootPath: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
    url: z.string().optional(),
    workspaceMember: z
      .object({
        description: z.string().optional(),
        name: z.string(),
        path: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
