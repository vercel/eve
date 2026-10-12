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
import { authoredRecord, authoredRender, type Reaction } from "../reaction.js";
import { slotsOf } from "../state.js";
import { slotValueOf } from "../state.js";

type Selection = Exclude<DurableDynamicSubagentSelection, null>;

/** A dynamic `subagents/<name>/agent.ts`: `defineAgent(...)`, `defineRemoteAgent(...)`, or `null`. */
export function subagentReaction(resolver: ResolvedDynamicSubagentResolver): Reaction {
  return {
    contribute: async (result, { ctx }) => {
      if (result === null || result === undefined) return { value: null };
      const { credentials, selection } = await selectionOf(ctx, resolver, result);
      const value = parseJsonValue(JSON.parse(JSON.stringify(selection)));
      // Credentials are code: the slot keeps the record they're rendered from, not them.
      return credentials === undefined ? { value } : { live: credentials, value };
    },
    id: `subagent:${resolver.nodeId}`,
    kind: "subagent",
    label: resolver.logicalPath,
    record: authoredRecord(resolver.logicalPath, resolver.record, {
      framework: resolver.framework,
    }),
    render: authoredRender(resolver.logicalPath, resolver.render, {
      framework: resolver.framework,
    }),
    select: resolver.select as Reaction["select"],
  };
}

/**
 * The dynamic subagents the session's slots select, by node id. A remote agent with credentials
 * carries the record they're rendered from.
 */
export function readDynamicSubagentSelections(
  ctx: Pick<ContextReader, "get"> | undefined,
): Readonly<Record<string, Selection>> {
  const selections: Record<string, Selection> = {};
  for (const { id, slot } of slotsOf(ctx, "subagent")) {
    const selection = slotValueOf<Selection | null>(slot.value);
    if (selection === null) continue;
    selections[id.slice("subagent:".length)] =
      selection.kind === "remote" && selection.remoteAgent.credentials === true
        ? { ...selection, record: slot.input ?? null }
        : selection;
  }
  return selections;
}

/**
 * Renders a dynamic remote agent's credentials from its record, where the session's state isn't:
 * the steps that open, message, reset, and cancel its child, and the route that follows the
 * child. The rendered destination must be the one the child was opened at, or the request fails
 * rather than send credentials elsewhere.
 */
export async function remoteAgentCredentials(input: {
  readonly resolvers: readonly ResolvedDynamicSubagentResolver[];
  readonly nodeId: string;
  readonly record: JsonValue | undefined;
  readonly destination: { readonly name: string; readonly url: string };
}): Promise<RemoteAgentCredentials> {
  const resolver = input.resolvers.find(({ nodeId }) => nodeId === input.nodeId);
  const render = authoredRender(resolver?.logicalPath ?? input.nodeId, resolver?.render);
  if (resolver === undefined || render === undefined || input.record === undefined) {
    throw new Error(
      `Remote agent "${input.destination.name}" carries credentials, but this deployment can't render them from what the session recorded.`,
    );
  }
  const rendered = await normalizeDynamicRemoteAgent({
    name: resolver.name,
    value: render(input.record),
  });
  if (resolver.name !== input.destination.name || rendered.config.url !== input.destination.url) {
    throw new Error(
      `Remote agent "${input.destination.name}" now renders another destination than the one its child was opened at, so eve doesn't send its credentials. Open a new child.`,
    );
  }
  return rendered.credentials ?? {};
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
): Promise<{ readonly selection: Selection; readonly credentials?: RemoteAgentCredentials }> {
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
    const { config: configured, credentials } = await normalizeDynamicRemoteAgent({
      name: resolver.name,
      value: result,
    });
    if (credentials !== undefined && resolver.render === undefined) {
      throw new Error(
        `Dynamic subagent "${resolver.name}" returned a remote agent with auth or headers from record. They're code, which eve can't keep: return the data from record, and defineRemoteAgent(...) from render.`,
      );
    }
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
  if (ctx.get(BundleKey)?.toolRegistry.toolsByName.has(resolver.name) !== true) return;
  throw new Error(
    `Dynamic subagent "${resolver.name}" from "${resolver.logicalPath}" collides with the tool "${resolver.name}". Set the subagent's tool to false when that tool wraps it.`,
  );
}
