/**
 * A session that declares dynamic definitions, for tests of how each kind installs what its
 * function returns. It holds only the bundle fields the reactions read.
 */

import { ContextContainer, contextStorage } from "#context/container.js";
import { HistoryStateKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import type { DynamicContext } from "#dynamic/definition.js";
import type { DynamicDefinitionKind } from "#runtime/types.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { createModelMetadata } from "#internal/model-catalog.js";
import { evaluateValues, stepDraft, stepMessages } from "#definitions/step.js";
import type { CatalogSkill } from "#execution/catalog/skills.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import { fromCompiledBundle } from "#definitions/compiled-agent.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

type Evaluate = (ctx: DynamicContext) => unknown;

/** What a build would bake for the model the fixture agents name. */
const MODEL_METADATA = createModelMetadata({
  catalog: {
    models: [
      {
        slug: "openai/gpt-5.4",
        providers: [
          { contextWindowTokens: 400_000, provider: "openai", providerModelId: "gpt-5.4" },
        ],
      },
    ],
    providerAliases: {},
  },
  fetchedAt: "2026-01-01T00:00:00.000Z",
});

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

function resolver<K extends DynamicDefinitionKind>(kind: K, source: DynamicSource) {
  const logicalPath = `${kind === "instructions" ? kind : `${kind}s`}/${source.slug}.ts`;
  return { ...source, kind, logicalPath, sourceId: logicalPath, sourceKind: "module" as const };
}

/** A session with the given dynamic definitions, authored tool names, and static connections. */
export function definitionSession(
  input: {
    /** Authored skills, which a dynamic skill of the same name overrides. */
    /** The agent's static user instructions. */
    readonly userInstructions?: readonly string[];
    readonly authoredSkills?: readonly {
      readonly content: string;
      readonly description: string;
      readonly name: string;
    }[];
    readonly connections?: readonly DynamicSource[];
    readonly instructions?: readonly DynamicSource[];
    /** The agent's static model. */
    readonly model?: { readonly id: string };
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
  ctx.set(
    SessionAgentKey,
    fromCompiledBundle({
      graph: { nodesByNodeId: new Map() },
      modelMetadata: async () => MODEL_METADATA,
      nodeId: "root",
      resolvedAgent: {
        definitions: [
          ...(input.instructions ?? []).map((source) => resolver("instructions", source)),
          ...(input.tools ?? []).map((source) => resolver("tool", source)),
          ...(input.skills ?? []).map((source) => resolver("skill", source)),
          ...(input.connections ?? []).map((source) => resolver("connection", source)),
        ],
        instructions: (input.userInstructions ?? []).map((content, index) => ({
          content,
          name: `instructions/user-${index}`,
          role: "user",
        })),
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
      turnAgent: { id: "agent", model: input.model },
    } as never),
  );
  const registry = new ConnectionRegistryImpl(input.staticConnections ?? []);
  ctx.set(ConnectionRegistryKey, registry);
  enterSessionProjection(ctx, undefined);
  return { ctx, registry };
}

/** Evaluates the session's dynamic values as eve does before a model call. */
export async function beforeModelCall(ctx: ContextContainer): Promise<void> {
  await contextStorage.run(ctx, () => evaluateValues(ctx, { conversation: [] }));
}

/**
 * The messages the session's next model call announces, after evaluating its values as eve does
 * before one; records them as announced, as the call's commit would.
 */
export async function announcedNext(ctx: ContextContainer): Promise<readonly string[]> {
  await beforeModelCall(ctx);
  return await contextStorage.run(ctx, async () => {
    const call = {
      currentInput: new Set<never>(),
      historyState: ctx.get(HistoryStateKey) ?? {},
      record: [],
    };
    const draft = await stepDraft(
      { config: { tools: new Map() }, ctx, finalReplyOnly: false, session: { rootSessionId: "" } },
      call,
    );
    const { historyState, record } = await stepMessages(draft, { call, project: (r) => [...r] });
    ctx.set(HistoryStateKey, historyState);
    return record.map(({ content }) => (typeof content === "string" ? content : ""));
  });
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

/** The skills the session's next model call can load, as its definitions contribute them. */
export async function callSkills(
  ctx: ContextContainer,
): Promise<ReadonlyMap<string, CatalogSkill>> {
  return await contextStorage.run(ctx, async () => {
    const draft = await stepDraft({
      config: { tools: new Map() },
      ctx,
      finalReplyOnly: false,
      session: { rootSessionId: "" },
    });
    return (await draft.tools()).skills;
  });
}

/** The dynamic tools the session's next model call offers, as its definitions kept them. */
export async function dynamicTools(ctx: ContextContainer): Promise<HarnessToolDefinition[]> {
  const tools = await contextStorage.run(ctx, async () => {
    const draft = await stepDraft({
      config: { tools: new Map() },
      ctx,
      finalReplyOnly: false,
      session: { rootSessionId: "" },
    });
    return await draft.tools();
  });
  return [...tools.entries.values()]
    .filter(({ source }) => source !== undefined)
    .map(({ definition }) => definition);
}
