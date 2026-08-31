import type { ModelMessage } from "ai";

import type { ContextContainer } from "#context/container.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import type { ContextReader } from "#context/key.js";
import {
  SessionDynamicSubagentRuntimeRevisionKey,
  SessionDynamicSubagentSelectionsKey,
  TurnDynamicSubagentSelectionsKey,
  type DurableDynamicSubagentResolverSelection,
  type DurableDynamicSubagentSelection,
} from "#context/keys.js";
import { createPreparedWorkflowToolHarnessDefinition } from "#execution/tools/workflow/background.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createLogger } from "#internal/logging.js";
import type { SessionStartedStreamEvent, UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { ResolvedDynamicSubagentResolver } from "#runtime/subagents/registry.js";
import { createPreparedRuntimeSubagentTool } from "#runtime/subagents/registry.js";
import { normalizeDynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { normalizeDynamicRemoteAgentConfig } from "#runtime/subagents/dynamic-remote-agent-config.js";
import { toErrorMessage } from "#shared/errors.js";

const log = createLogger("dynamic-subagents");
const ALLOWED_DYNAMIC_SUBAGENT_EVENTS = new Set(["session.started", "turn.started"]);

type DynamicSubagentSelections = Readonly<Record<string, DurableDynamicSubagentResolverSelection>>;

function dynamicSubagentEntryNodeId(resolverNodeId: string, entryKey: string): string {
  return `${resolverNodeId}#${entryKey}`;
}

function dynamicSubagentResolverNodeId(nodeId: string): string {
  return nodeId.split("#", 1)[0]!;
}

function isRemoteAgentMap(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isRemoteAgentDefinition)
  );
}

function isDynamicSubagentMapSelection(
  value: DurableDynamicSubagentResolverSelection,
): value is Readonly<Record<string, DurableDynamicSubagentSelection>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Object.hasOwn(value, "kind") &&
    Object.values(value).every(
      (entry) => entry === null || (typeof entry === "object" && entry.kind === "remote"),
    )
  );
}

async function resolveRemoteSelection(input: {
  readonly name: string;
  readonly nodeId: string;
  readonly resolver: ResolvedDynamicSubagentResolver;
  readonly value: unknown;
}): Promise<Exclude<DurableDynamicSubagentSelection, null>> {
  const remoteAgent = await normalizeDynamicRemoteAgentConfig({
    name: input.name,
    value: input.value,
  });
  const prepared = createPreparedRuntimeSubagentTool({
    description: remoteAgent.description,
    kind: "remote",
    logicalPath: input.resolver.logicalPath,
    name: input.name,
    nodeId: input.nodeId,
    outputSchema: remoteAgent.outputSchema,
    path: remoteAgent.path,
    sourceId: input.resolver.sourceId,
    sourceKind: input.resolver.sourceKind,
    url: remoteAgent.url,
  });
  return { kind: "remote", prepared, remoteAgent };
}

async function resolveSelections(input: {
  readonly ctx: ContextContainer;
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
  readonly resolvers: readonly ResolvedDynamicSubagentResolver[];
}): Promise<DynamicSubagentSelections> {
  const outcomes = await Promise.allSettled(
    input.resolvers.map(async (resolver) => {
      const handler = resolver.events[input.event.type];
      if (handler === undefined) return [resolver.nodeId, null] as const;

      const result = await handler(input.event, buildResolveContext(input.ctx, input.messages));
      if (result === null || result === undefined) return [resolver.nodeId, null] as const;
      if (isRemoteAgentDefinition(result)) {
        return [
          resolver.nodeId,
          await resolveRemoteSelection({
            name: resolver.name,
            nodeId: resolver.nodeId,
            resolver,
            value: result,
          }),
        ] as const;
      }

      if (isRemoteAgentMap(result)) {
        const entries: Record<string, DurableDynamicSubagentSelection> = {};
        for (const [entryKey, value] of Object.entries(result)) {
          if (!isRemoteAgentDefinition(value)) {
            throw new Error(
              `Dynamic subagent resolver "${resolver.logicalPath}" returned "${entryKey}" without defineRemoteAgent(). Dynamic subagent maps may contain only defineRemoteAgent() values.`,
            );
          }
          entries[entryKey] = await resolveRemoteSelection({
            name: `${resolver.name}__${entryKey}`,
            nodeId: dynamicSubagentEntryNodeId(resolver.nodeId, entryKey),
            resolver,
            value,
          });
        }
        return [resolver.nodeId, entries] as const;
      }

      const agentConfig = normalizeDynamicSubagentAgentConfig({
        name: resolver.name,
        state: input.ctx,
        value: result,
      });
      const resolvedAgentConfig = await agentConfig;
      const prepared = createPreparedRuntimeSubagentTool({
        description: resolvedAgentConfig.description,
        kind: "subagent",
        logicalPath: resolver.logicalPath,
        name: resolver.name,
        nodeId: resolver.nodeId,
        sourceId: resolver.sourceId,
        sourceKind: resolver.sourceKind,
      });
      return [
        resolver.nodeId,
        { agentConfig: resolvedAgentConfig, kind: "subagent", prepared },
      ] as const;
    }),
  );
  const selections: Record<string, DurableDynamicSubagentResolverSelection> = {};

  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index]!;
    const resolver = input.resolvers[index]!;
    if (outcome.status === "rejected") {
      log.error(`Dynamic subagent resolver (${input.event.type}) threw — omitting subagent.`, {
        error: toErrorMessage(outcome.reason),
        subagentName: resolver.name,
      });
      selections[resolver.nodeId] = null;
      continue;
    }
    selections[outcome.value[0]] = outcome.value[1];
  }

  return selections;
}

function isRemoteAgentDefinition(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly kind?: unknown }).kind === "remote"
  );
}

export async function dispatchDynamicSubagentEvent(input: {
  readonly ctx: ContextContainer;
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
  readonly resolvers: readonly ResolvedDynamicSubagentResolver[];
}): Promise<void> {
  if (!ALLOWED_DYNAMIC_SUBAGENT_EVENTS.has(input.event.type)) return;

  const resolvers = input.resolvers.filter((resolver) =>
    resolver.eventNames.includes(input.event.type),
  );
  const selections = await resolveSelections({ ...input, resolvers });
  input.ctx.set(
    input.event.type === "session.started"
      ? SessionDynamicSubagentSelectionsKey
      : TurnDynamicSubagentSelectionsKey,
    selections,
  );
}

export async function refreshDynamicSessionSubagentsForRuntimeRevision(input: {
  readonly ctx: ContextContainer;
  readonly event: SessionStartedStreamEvent;
  readonly messages: readonly ModelMessage[];
  readonly resolvers: readonly ResolvedDynamicSubagentResolver[];
  readonly runtimeRevision: string;
}): Promise<void> {
  if (input.ctx.get(SessionDynamicSubagentRuntimeRevisionKey) === input.runtimeRevision) return;

  const resolvers = input.resolvers.filter((resolver) =>
    resolver.eventNames.includes("session.started"),
  );
  const selections = await resolveSelections({ ...input, resolvers });
  input.ctx.set(SessionDynamicSubagentSelectionsKey, selections);
  input.ctx.set(SessionDynamicSubagentRuntimeRevisionKey, input.runtimeRevision);
}

export function buildDynamicSubagentTools(input: ContextReader): readonly HarnessToolDefinition[] {
  const effective = {
    ...input.get(SessionDynamicSubagentSelectionsKey),
    ...input.get(TurnDynamicSubagentSelectionsKey),
  };
  const tools: HarnessToolDefinition[] = [];
  const names = new Set<string>();

  for (const resolverSelection of Object.values(effective)) {
    const selections =
      resolverSelection !== null && isDynamicSubagentMapSelection(resolverSelection)
        ? Object.values(resolverSelection)
        : [resolverSelection];
    for (const selection of selections) {
      if (selection === null) continue;
      if (names.has(selection.prepared.name)) {
        throw new Error(
          `Found multiple active dynamic subagents named "${selection.prepared.name}". Subagent names must be unique at runtime.`,
        );
      }
      names.add(selection.prepared.name);
      tools.push(createPreparedWorkflowToolHarnessDefinition(selection.prepared));
    }
  }

  return tools;
}

export function getDynamicSubagentSelection(
  input: ContextReader,
  nodeId: string,
): Exclude<DurableDynamicSubagentSelection, null> | undefined {
  const resolverNodeId = dynamicSubagentResolverNodeId(nodeId);
  const entryKey = nodeId.slice(resolverNodeId.length + 1);
  const turn = input.get(TurnDynamicSubagentSelectionsKey) ?? {};
  const resolverSelection = Object.hasOwn(turn, resolverNodeId)
    ? turn[resolverNodeId]
    : (input.get(SessionDynamicSubagentSelectionsKey) ?? {})[resolverNodeId];
  if (resolverSelection === undefined || resolverSelection === null) return undefined;
  if (isDynamicSubagentMapSelection(resolverSelection)) {
    return entryKey === "" ? undefined : (resolverSelection[entryKey] ?? undefined);
  }
  return entryKey === "" ? resolverSelection : undefined;
}

export function isDynamicSubagentNodeId(
  dynamicResolverNodeIds: ReadonlySet<string>,
  nodeId: string,
): boolean {
  return dynamicResolverNodeIds.has(dynamicSubagentResolverNodeId(nodeId));
}
