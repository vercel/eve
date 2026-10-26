/**
 * A session that declares dynamic definitions, for tests of how each kind installs what its
 * function returns. It holds only the bundle fields the reactions read.
 */

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey, SessionKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import type { DynamicContext } from "#dynamic/definition.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { evaluateValues } from "#reactions/runner.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

type Evaluate = (ctx: DynamicContext) => unknown;

export interface DynamicSource {
  readonly evaluate: Evaluate;
  readonly slug: string;
  readonly extensionNamespace?: string;
}

export interface DynamicSubagentSource {
  readonly evaluate: Evaluate;
  readonly name: string;
  readonly tool?: false;
}

function resolver(kind: string, source: DynamicSource) {
  const logicalPath = `${kind}/${source.slug}.ts`;
  return { ...source, logicalPath, sourceId: logicalPath, sourceKind: "module" as const };
}

/** A session with the given dynamic definitions, authored tool names, and static connections. */
export function reactionSession(
  input: {
    /** Authored skills, which a dynamic skill of the same name overrides. */
    readonly authoredSkills?: readonly {
      readonly content: string;
      readonly description: string;
      readonly name: string;
    }[];
    readonly connections?: readonly DynamicSource[];
    readonly instructions?: readonly DynamicSource[];
    readonly skills?: readonly DynamicSource[];
    readonly staticConnections?: readonly ResolvedConnectionDefinition[];
    readonly subagents?: readonly DynamicSubagentSource[];
    readonly tools?: readonly DynamicSource[];
    /** Authored tools, by name; a value with `workflow` runs as a workflow tool. */
    readonly toolNames?: readonly (string | { readonly name: string; readonly workflow: true })[];
  } = {},
) {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, `session-${Math.random()}`);
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: ctx.get(SessionIdKey),
  } as never);
  const toolsByName = new Map(
    (input.toolNames ?? []).map((tool) => {
      const name = typeof tool === "string" ? tool : tool.name;
      const behavior =
        typeof tool === "string"
          ? undefined
          : {
              availability: [],
              handling: {
                kind: "dispatch",
                target: { entryPoint: "execute", kind: "workflow-tool-call", workflowId: name },
              },
            };
      return [name, { prepared: { behavior, name } }];
    }),
  );
  ctx.set(BundleKey, {
    nodeId: "root",
    resolvedAgent: {
      dynamicConnectionResolvers: (input.connections ?? []).map((source) =>
        resolver("connections", source),
      ),
      dynamicInstructionsResolvers: (input.instructions ?? []).map((source) =>
        resolver("instructions", source),
      ),
      dynamicSkillResolvers: (input.skills ?? []).map((source) => resolver("skills", source)),
      dynamicToolResolvers: (input.tools ?? []).map((source) => resolver("tools", source)),
      hooks: [],
      memories: [],
      skills: input.authoredSkills ?? [],
    },
    subagentRegistry: {
      dynamicResolvers: (input.subagents ?? []).map((source) => ({
        ...source,
        kind: "subagent",
        logicalPath: `subagents/${source.name}/agent.ts`,
        nodeId: `subagents/${source.name}`,
        sourceId: `subagents/${source.name}/agent.ts`,
        sourceKind: "module",
      })),
      preparedTools: [],
      subagentsByName: new Map(),
    },
    toolRegistry: { toolsByName },
    turnAgent: { id: "agent" },
  } as never);
  const registry = new ConnectionRegistryImpl(input.staticConnections ?? []);
  ctx.set(ConnectionRegistryKey, registry);
  enterSessionProjection(ctx, undefined);
  return { ctx, registry };
}

/** Evaluates the session's dynamic values as eve does before a model call. */
export async function beforeModelCall(ctx: ContextContainer): Promise<void> {
  await contextStorage.run(ctx, () => evaluateValues(ctx, { conversation: [] }));
}

/** The message of the error the session's next evaluation fails with. */
export async function evaluationError(ctx: ContextContainer): Promise<string> {
  try {
    await beforeModelCall(ctx);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the evaluation to fail.");
}
