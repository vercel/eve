import { assertNotConnectionOwned } from "#connections/ownership.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import type { DurableDynamicSubagentSelection } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { createPreparedWorkflowToolHarnessDefinition } from "#execution/tools/workflow/harness-definition.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { eveNamespaceReservation } from "#protocol/runtime-tools.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { normalizeDynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { normalizeDynamicRemoteAgentConfig } from "#runtime/subagents/dynamic-remote-agent-config.js";
import {
  createPreparedRuntimeSubagentTool,
  type ResolvedDynamicSubagentResolver,
} from "#runtime/subagents/registry.js";
import type { AgentToolExposure } from "#shared/agent-definition.js";
import { parseJsonValue } from "#shared/json.js";
import { authoredResolve, type Reaction } from "../reaction.js";
import { slotsOf } from "../runner.js";

type Selection = Exclude<DurableDynamicSubagentSelection, null>;

/** A dynamic `subagents/<name>/agent.ts`: `defineAgent(...)`, `defineRemoteAgent(...)`, or `null`. */
export function subagentReaction(resolver: ResolvedDynamicSubagentResolver): Reaction {
  return {
    contribute: async (result, { ctx }) => {
      if (result === null || result === undefined) return { value: null };
      const selection = await selectionOf(ctx, resolver, result);
      return { value: parseJsonValue(JSON.parse(JSON.stringify(selection))) };
    },
    id: `subagent:${resolver.nodeId}`,
    kind: "subagent",
    label: resolver.logicalPath,
    resolve: authoredResolve(resolver.logicalPath, resolver.resolve),
    select: resolver.select as Reaction["select"],
  };
}

/** The dynamic subagents the session's slots select, by node id. */
export function readDynamicSubagentSelections(
  ctx: Pick<ContextReader, "get"> | undefined,
): Readonly<Record<string, Selection>> {
  const selections: Record<string, Selection> = {};
  for (const { id, slot } of slotsOf(ctx, "subagent")) {
    const selection = slot.value as unknown as Selection | null;
    if (selection !== null) selections[id.slice("subagent:".length)] = selection;
  }
  return selections;
}

/** The model-visible tools of the selected dynamic subagents. */
export function buildDynamicSubagentTools(
  ctx: Pick<ContextReader, "get">,
): readonly HarnessToolDefinition[] {
  return Object.values(readDynamicSubagentSelections(ctx)).flatMap((selection) => {
    const tool =
      selection.kind === "subagent" ? selection.agentConfig.tool : selection.remoteAgent.tool;
    return tool === false ? [] : [createPreparedWorkflowToolHarnessDefinition(selection.prepared)];
  });
}

async function selectionOf(
  ctx: ContextContainer,
  resolver: ResolvedDynamicSubagentResolver,
  result: unknown,
): Promise<Selection> {
  assertNotConnectionOwned({
    connectionNames: ctx.get(ConnectionRegistryKey)?.getConnectionNames() ?? [],
    name: resolver.name,
    remedy: "Rename the subagent directory.",
    subject: "Dynamic subagent",
  });
  const location = {
    logicalPath: resolver.logicalPath,
    name: resolver.name,
    nodeId: resolver.nodeId,
    sourceId: resolver.sourceId,
    sourceKind: resolver.sourceKind,
  };
  if ((result as { readonly kind?: unknown }).kind === "remote") {
    const configured = await normalizeDynamicRemoteAgentConfig({
      name: resolver.name,
      value: result,
    });
    const remoteAgent =
      resolver.tool === false ? { ...configured, tool: false as const } : configured;
    assertToolNameAvailable(ctx, resolver, remoteAgent.tool);
    const prepared = createPreparedRuntimeSubagentTool({
      ...location,
      description: remoteAgent.description,
      kind: "remote",
      path: remoteAgent.path,
      tool: remoteAgent.tool,
      url: remoteAgent.url,
    });
    return { kind: "remote", prepared, remoteAgent };
  }
  const configured = await normalizeDynamicSubagentAgentConfig({
    name: resolver.name,
    state: ctx,
    value: result,
  });
  const agentConfig =
    resolver.tool === false ? { ...configured, tool: false as const } : configured;
  assertToolNameAvailable(ctx, resolver, agentConfig.tool);
  const prepared = createPreparedRuntimeSubagentTool({
    ...location,
    description: agentConfig.description,
    kind: "subagent",
    tool: agentConfig.tool,
  });
  return { agentConfig, kind: "subagent", prepared };
}

/**
 * No dynamic subagent may take a name in eve's namespace. One the model can call can't take a
 * tool's name either; with `tool: false` it can, since a same-named authored tool then wraps it.
 */
function assertToolNameAvailable(
  ctx: ContextContainer,
  resolver: ResolvedDynamicSubagentResolver,
  tool: AgentToolExposure | undefined,
): void {
  const reservation = eveNamespaceReservation(resolver.name);
  if (reservation !== undefined) {
    throw new Error(
      `Dynamic subagent "${resolver.name}" from "${resolver.logicalPath}" uses the reserved name "${resolver.name}". ${reservation}; rename the subagent.`,
    );
  }
  if (tool === false) return;
  if (ctx.get(BundleKey)?.toolRegistry.toolsByName.has(resolver.name) !== true) return;
  throw new Error(
    `Dynamic subagent "${resolver.name}" from "${resolver.logicalPath}" collides with the tool "${resolver.name}". Set the subagent's tool to false when that tool wraps it.`,
  );
}
