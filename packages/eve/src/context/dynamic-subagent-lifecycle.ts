import type { ModelMessage } from "ai";

import type { ContextContainer } from "#context/container.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import type { ContextReader } from "#context/key.js";
import {
  SessionDynamicSubagentRuntimeRevisionKey,
  SessionDynamicSubagentSelectionsKey,
  TurnDynamicSubagentSelectionsKey,
  type DurableDynamicSubagentSelection,
} from "#context/keys.js";
import { createHarnessDelegationToolDefinition } from "#execution/delegation-tool.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createLogger } from "#internal/logging.js";
import type { SessionStartedStreamEvent, UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { ResolvedDynamicSubagentResolver } from "#runtime/subagents/registry.js";
import { createPreparedRuntimeSubagentTool } from "#runtime/subagents/registry.js";
import { normalizeDynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { toErrorMessage } from "#shared/errors.js";

const log = createLogger("dynamic-subagents");
const ALLOWED_DYNAMIC_SUBAGENT_EVENTS = new Set(["session.started", "turn.started"]);

type DynamicSubagentSelections = Readonly<Record<string, DurableDynamicSubagentSelection>>;

async function resolveSelections(input: {
  readonly ctx: ContextContainer;
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
  readonly resolvers: readonly ResolvedDynamicSubagentResolver[];
}): Promise<DynamicSubagentSelections> {
  const outcomes = await Promise.allSettled(
    input.resolvers.map(async (resolver) => {
      const handler = resolver.events[input.event.type];
      if (handler === undefined) {
        return [resolver.nodeId, null] as const;
      }

      const result = await handler(input.event, buildResolveContext(input.ctx, input.messages));
      if (result === null || result === undefined) {
        return [resolver.nodeId, null] as const;
      }
      const agentConfig = normalizeDynamicSubagentAgentConfig({
        name: resolver.name,
        value: result,
      });
      const prepared = createPreparedRuntimeSubagentTool({
        description: agentConfig.description,
        kind: resolver.kind,
        logicalPath: resolver.logicalPath,
        name: resolver.name,
        nodeId: resolver.nodeId,
        sourceId: resolver.sourceId,
        sourceKind: resolver.sourceKind,
      });

      return [resolver.nodeId, { agentConfig, prepared }] as const;
    }),
  );
  const selections: Record<string, DurableDynamicSubagentSelection> = {};

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

export async function dispatchDynamicSubagentEvent(input: {
  readonly ctx: ContextContainer;
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
  readonly resolvers: readonly ResolvedDynamicSubagentResolver[];
}): Promise<void> {
  if (!ALLOWED_DYNAMIC_SUBAGENT_EVENTS.has(input.event.type)) {
    return;
  }

  const matching = input.resolvers.filter((resolver) =>
    resolver.eventNames.includes(input.event.type),
  );
  const selections = await resolveSelections({ ...input, resolvers: matching });

  if (input.event.type === "session.started") {
    input.ctx.set(SessionDynamicSubagentSelectionsKey, selections);
  } else {
    input.ctx.set(TurnDynamicSubagentSelectionsKey, selections);
  }
}

export async function refreshDynamicSessionSubagentsForRuntimeRevision(input: {
  readonly ctx: ContextContainer;
  readonly event: SessionStartedStreamEvent;
  readonly messages: readonly ModelMessage[];
  readonly resolvers: readonly ResolvedDynamicSubagentResolver[];
  readonly runtimeRevision: string;
}): Promise<void> {
  if (input.ctx.get(SessionDynamicSubagentRuntimeRevisionKey) === input.runtimeRevision) {
    return;
  }

  const matching = input.resolvers.filter((resolver) =>
    resolver.eventNames.includes("session.started"),
  );
  const selections = await resolveSelections({ ...input, resolvers: matching });
  input.ctx.set(SessionDynamicSubagentSelectionsKey, selections);
  input.ctx.set(SessionDynamicSubagentRuntimeRevisionKey, input.runtimeRevision);
}

export function buildDynamicSubagentTools(input: ContextReader): readonly HarnessToolDefinition[] {
  const session = input.get(SessionDynamicSubagentSelectionsKey) ?? {};
  const turn = input.get(TurnDynamicSubagentSelectionsKey) ?? {};
  const effective = { ...session, ...turn };
  const tools: HarnessToolDefinition[] = [];
  const names = new Set<string>();

  for (const selection of Object.values(effective)) {
    if (selection === null) {
      continue;
    }
    if (names.has(selection.prepared.name)) {
      throw new Error(
        `Found multiple active dynamic subagents named "${selection.prepared.name}". Subagent names must be unique at runtime.`,
      );
    }
    names.add(selection.prepared.name);
    tools.push(createHarnessDelegationToolDefinition(selection.prepared));
  }

  return tools;
}

export function getDynamicSubagentSelection(
  input: ContextReader,
  nodeId: string,
): Exclude<DurableDynamicSubagentSelection, null> | undefined {
  const turn = input.get(TurnDynamicSubagentSelectionsKey) ?? {};
  if (Object.hasOwn(turn, nodeId)) {
    return turn[nodeId] ?? undefined;
  }

  const session = input.get(SessionDynamicSubagentSelectionsKey) ?? {};
  return session[nodeId] ?? undefined;
}
