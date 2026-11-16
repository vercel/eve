import { assertNotConnectionOwned } from "#connections/ownership.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import type { DurableDynamicSubagentSelection } from "#context/keys.js";
import { createPreparedWorkflowToolHarnessDefinition } from "#execution/tools/workflow/harness-definition.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { eveNamespaceReservation } from "#protocol/runtime-tools.js";
import { compiledBundleOf, requireCompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { normalizeDynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import {
  normalizeDynamicRemoteAgent,
  type RemoteAgentCredentials,
} from "#runtime/subagents/dynamic-remote-agent-config.js";
import {
  createPreparedRuntimeSubagentTool,
  type ResolvedDynamicSubagentResolver,
} from "#runtime/subagents/registry.js";
import type { AgentToolExposure } from "#shared/agent-definition.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import { bindingOf } from "#definitions/remote.js";
import { entryVersions, slotsOf, slotValueOf } from "#definitions/state.js";
import { sessionConnectionNames } from "./connections.js";
import { authoredEvaluate, type Definition } from "./definition.js";

type Selection = Exclude<DurableDynamicSubagentSelection, null>;

/**
 * A dynamic `subagents/<name>/agent.ts`: `defineAgent(...)`, `defineRemoteAgent(...)`, or `null`. It
 * keeps the selection, and offers the model a tool for it unless its `tool` is `false`.
 */
export function subagentDefinition(resolver: ResolvedDynamicSubagentResolver): Definition {
  const id = `subagent:${resolver.nodeId}`;
  const evaluate = authoredEvaluate(resolver.evaluate);
  return {
    contribute: (ctx) => ({
      tools: async () => {
        const kept = await ctx.keep(async (evaluation) => {
          const result = await evaluate(evaluation);
          if (result === null || result === undefined) return null;
          const { credentials, selection } = await selectionOf(evaluation.ctx, resolver, result);
          const value = parseJsonValue(JSON.parse(JSON.stringify(selection)));
          // Credentials are code: the slot keeps the record they're rendered from, not them.
          return credentials === undefined ? { value } : { live: credentials, value };
        });
        const tool = subagentTool(ctx.container, id, kept?.value ?? null);
        return {
          entries: new Map(
            tool === undefined ? [] : [[tool.name, { definition: tool, source: id }]],
          ),
        };
      },
    }),
    id,
    label: resolver.logicalPath,
  };
}

/**
 * The dynamic subagents the session's slots select, by node id. A remote agent with credentials
 * carries the binding a child opened now keeps, from which they're built again.
 */
export function readDynamicSubagentSelections(
  ctx: ContextReader,
): Readonly<Record<string, Selection>> {
  const selections: Record<string, Selection> = {};
  for (const { id, slot } of slotsOf(ctx, "subagent")) {
    const selection = slotValueOf<Selection | null>(slot.value);
    if (selection === null) continue;
    const nodeId = id.slice("subagent:".length);
    selections[nodeId] =
      selection.kind === "remote" && selection.remoteAgent.credentials === true
        ? { ...selection, binding: bindingOf(ctx, nodeId) }
        : selection;
  }
  return selections;
}

/** The model-visible tool of a selected dynamic subagent. */
function subagentTool(
  ctx: ContextReader,
  id: string,
  value: JsonValue,
): HarnessToolDefinition | undefined {
  const selection = slotValueOf<Selection | null>(value);
  if (selection === null) return undefined;
  const tool =
    selection.kind === "subagent" ? selection.agentConfig.tool : selection.remoteAgent.tool;
  if (tool === false) return undefined;
  return {
    ...createPreparedWorkflowToolHarnessDefinition(selection.prepared),
    version: entryVersions(ctx, id)(value),
  };
}

async function selectionOf(
  ctx: ContextContainer,
  resolver: ResolvedDynamicSubagentResolver,
  result: unknown,
): Promise<{ readonly selection: Selection; readonly credentials?: RemoteAgentCredentials }> {
  assertNotConnectionOwned({
    connectionNames: sessionConnectionNames(ctx),
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
    const { config: configured, credentials } = await normalizeDynamicRemoteAgent({
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
    const selection: Selection = { kind: "remote", prepared, remoteAgent };
    return credentials === undefined ? { selection } : { credentials, selection };
  }
  const configured = await normalizeDynamicSubagentAgentConfig({
    modelMetadata: requireCompiledBundle(ctx).modelMetadata,
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
  return { selection: { agentConfig, kind: "subagent", prepared } };
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
  if (compiledBundleOf(ctx)?.toolRegistry.toolsByName.has(resolver.name) !== true) return;
  throw new Error(
    `Dynamic subagent "${resolver.name}" from "${resolver.logicalPath}" collides with the tool "${resolver.name}". Set the subagent's tool to false when that tool wraps it.`,
  );
}
