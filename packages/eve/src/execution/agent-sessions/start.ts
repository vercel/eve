import type { MessageContent } from "#shared/message-content.js";
import { NonRetryableError } from "#shared/run-errors.js";
import type { RunInput, SessionCommand } from "#channel/types.js";
import type { SessionAuth } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { AgentSessionRuntimeOverrides } from "#execution/agent-sessions/runtime-overrides.js";
import {
  resolveAgentAction,
  resolveAgentStartTarget,
  type SubagentStartTarget,
} from "#execution/agent-sessions/target.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import { resolveDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import {
  InvalidRuntimeModelSelectionError,
  resolveRuntimeModelSelection,
} from "#runtime/agent/resolve-model.js";
import { toErrorMessage } from "#shared/errors.js";
import type { JsonObject } from "#shared/json.js";
import type { SubagentParentContext } from "#subagents/invocation.js";
import type { DynamicRemoteBinding } from "#definitions/remote.js";
import { buildSubagentRunInput } from "#subagents/tool.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
import { stubToolPath } from "#tool-stubs/target.js";
import type { AgentSessionModelSelection } from "#tools/workflow-definition.js";
import { readAgentToolModels } from "#tools/agent-models.js";
import { selectionModel } from "#models/options.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";

// How a run's `ctx.agent` resolves and prepares the session it opens, on any host. Workflow opens
// it in a step (`steps.ts`); the in-process host opens it in its process. Both go through
// `agentSessionsOver` (`sessions-over.ts`), which chooses between a local and a remote session.

/** Where a session a run opened lives, for its later sends, cancels, and end. */
export type AgentSessionAddress =
  | {
      readonly kind: "local";
      readonly name: string;
      readonly nodeId: string;
      readonly sessionId: string;
      /** Names the session to whichever run holds its inbox. */
      readonly continuationToken: string;
    }
  | {
      readonly callbackBaseUrl: string;
      readonly kind: "remote";
      readonly forwardPrincipal?: boolean;
      readonly name: string;
      readonly nodeId: string;
      /** Keys the authored credential functions, as on `child.opened`. */
      readonly resolverId?: string;
      /**
       * A dynamic remote agent's binding, which its credentials are built from again: the child
       * keeps the session it was opened with, whatever the parent's session becomes. Private.
       */
      readonly dynamicBinding?: DynamicRemoteBinding;
      readonly sessionId: string;
      readonly url: string;
      /** The child's remote agent protocol, when it speaks an earlier one than this deployment. */
      readonly earlierProtocol?: number;
    };

/** A session a run opened, with the context of the call that opened it: its lineage. */
export interface OpenedAgentSession {
  readonly address: AgentSessionAddress;
  readonly context: AgentSessionContext;
  /** Names the session within its run, as when it opened. */
  readonly key: string;
}

/**
 * A message a session accepted. An earlier-protocol remote agent names no delivery, so
 * nothing records it.
 */
export interface AgentSessionReceipt {
  readonly sessionId: string;
  readonly deliveryId?: string;
}

/**
 * One message to a session, as the call that sends it: the session runs the
 * message with that call's auth. Its turn's result and questions arrive on
 * `replyTo`.
 */
export interface AgentSessionMessage {
  readonly auth: SessionAuth;
  readonly message: MessageContent<string | URL>;
  readonly outputSchema?: JsonObject;
  readonly replyTo: string;
}

/** What a run's `ctx.agent(name)` opens a session with: its first message, and who opens it. */
export type AgentSessionOpenInput = AgentSessionMessage & {
  readonly context: AgentSessionContext;
  readonly key: string;
  readonly model?: AgentSessionModelSelection;
  readonly name: string;
  /** The workflow tool whose run opens the session. */
  readonly toolName?: string;
};

/** A session a run started, as the run addresses it. */
export interface StartedAgentSession {
  readonly address: AgentSessionAddress;
  /** The opening message's delivery; an earlier-protocol remote agent names none. */
  readonly deliveryId?: string;
}

export type LocalAgentSession = OpenedAgentSession & {
  readonly address: Extract<AgentSessionAddress, { readonly kind: "local" }>;
};

export type RemoteAgentSession = OpenedAgentSession & {
  readonly address: Extract<AgentSessionAddress, { readonly kind: "remote" }>;
};

/** The command that sends a later message to a local session, as the call that sends it. */
export function localAgentSendCommand(
  input: AgentSessionMessage & LocalAgentSession,
  deliveryId: string,
) {
  const { address, context } = input;
  return {
    auth: input.auth.current,
    schedule: context.schedule,
    caller: {
      callId: context.parent.callId,
      replyTo: { kind: "hook", token: input.replyTo },
      subagentName: address.name,
    },
    kind: "send",
    delivery: { channelKind: "subagent", channelName: "subagent", deliveryId },
    payload: { message: input.message, outputSchema: input.outputSchema },
  } as const satisfies SessionCommand;
}

/** Why a run's sessions end with it. */
export const AGENT_SESSION_RUN_FINISHED_REASON =
  "The workflow run that opened this session finished.";

/** The command that ends a session its run is done with, delivered as `deliveryId`. */
export function agentSessionResetCommand(deliveryId: string) {
  return {
    kind: "reset",
    reason: AGENT_SESSION_RUN_FINISHED_REASON,
    deliveryId,
  } as const satisfies SessionCommand;
}

export interface SessionStart<Target extends SubagentStartTarget> {
  readonly auth: SessionAuth;
  readonly bundle: CompiledBundle;
  readonly context: AgentSessionContext;
  readonly key: string;
  readonly replyTo: string;
  readonly runtimeOverrides?: AgentSessionRuntimeOverrides;
  readonly target: Target;
}

export type LocalStartTarget = Extract<SubagentStartTarget, { readonly kind: "local" }>;
export type RemoteStartTarget = Extract<SubagentStartTarget, { readonly kind: "remote" }>;

/** A local child session, ready to start on whichever host runs its parent's run. */
export interface PreparedLocalAgentSession {
  /** Starts the child, its first message delivered as `deliveryId`. */
  readonly runInput: RunInput;
  /** What the child's runtime runs: its agent, and any overrides. */
  readonly runtime: SessionRuntimeConfig;
  /** The child's address, once a session id is known. */
  readonly address: (sessionId: string) => Extract<AgentSessionAddress, { readonly kind: "local" }>;
  readonly childContinuationToken: string;
  readonly deliveryId: string;
}

/**
 * Builds the local session a run's `ctx.agent` starts, without starting it: Workflow starts it as
 * a durable run, and the in-process host in its process.
 */
export function prepareLocalAgentSession(
  input: SessionStart<LocalStartTarget>,
): PreparedLocalAgentSession {
  const { auth, bundle, context, target } = input;
  const { action } = target;
  const { childContinuationToken, runInput } = buildSubagentRunInput({
    action,
    auth: auth.current,
    capabilities: context.capabilities,
    schedule: context.schedule,
    channelMetadata: context.channelMetadata,
    continuationKey: input.key,
    graph: bundle.graph,
    inheritedConversation: context.conversation,
    initiatorAuth: auth.initiator,
    parent: createParentContext(context, input.replyTo),
    sandboxSessionId: context.sandbox.sessionId,
    selfAgent: target.source.type === "runtime",
    session: {
      continuationToken: input.replyTo,
      sandboxState: context.sandbox.state,
      sessionId: context.parent.sessionId,
    },
    source: target.source,
  });
  let childToolStubs = context.toolStubs;
  if (childToolStubs !== undefined) {
    childToolStubs = {
      ...childToolStubs,
      agentPath: stubToolPath(childToolStubs, action.name),
    };
  }
  const deliveryId = `agent-session:${input.key}:initial`;
  return {
    address: (sessionId) => ({
      continuationToken: childContinuationToken,
      kind: "local",
      name: action.name,
      nodeId: action.nodeId,
      sessionId,
    }),
    childContinuationToken,
    deliveryId,
    runInput: {
      ...runInput,
      delivery: { channelKind: "subagent", channelName: "subagent", deliveryId },
      toolStubs: childToolStubs,
    },
    runtime: {
      agentSessionRuntimeOverrides: input.runtimeOverrides,
      compiledArtifactsSource: bundle.compiledArtifactsSource,
      dynamicSubagentAgentConfig: target.dynamicSubagentAgentConfig,
      nodeId: action.nodeId,
    },
  };
}

/**
 * Resolves what a run's `ctx.agent(name)` opens: the agent, its target, and any model override.
 * Host-free; the host starts the session it resolves.
 */
export async function resolveAgentSessionStart(
  input: AgentSessionOpenInput,
): Promise<SessionStart<SubagentStartTarget> & { readonly agentName: string }> {
  const { context } = input;
  const bundle = await loadAgentSessionBundle(context);
  const action = resolveAgentAction({
    bundle,
    callId: context.parent.callId,
    dynamicSelections: context.dynamicSelections,
    input: { message: input.message, outputSchema: input.outputSchema, target: input.name },
  });
  const target = resolveAgentStartTarget({
    action,
    bundle,
    dynamicSelections: context.dynamicSelections,
    isRootSession: context.parent.rootSessionId === context.parent.sessionId,
  });
  if (input.model !== undefined && target.kind === "remote") {
    throw new NonRetryableError(
      `ctx.agent("${input.name}", { model }) cannot override a remote agent's model. Configure the model on the receiving agent.`,
    );
  }
  const runtimeOverrides =
    input.model === undefined
      ? undefined
      : await normalizeRuntimeOverrides({
          bundle,
          model: input.model,
          name: input.name,
          toolName: input.toolName,
        });
  return {
    agentName: action.name,
    auth: input.auth,
    bundle,
    context,
    key: input.key,
    replyTo: input.replyTo,
    runtimeOverrides,
    target,
  };
}

async function normalizeRuntimeOverrides({
  bundle,
  model,
  name,
  toolName,
}: {
  readonly bundle: CompiledBundle;
  readonly model: AgentSessionModelSelection;
  readonly name: string;
  readonly toolName: string | undefined;
}): Promise<AgentSessionRuntimeOverrides> {
  const tool = await loadAgentModelsTool(bundle, toolName);
  if (tool !== undefined) {
    return { model: await resolveAgentToolModel(bundle, tool, model) };
  }
  try {
    const selection = await resolveRuntimeModelSelection({
      durability: "durable",
      modelMetadata: bundle.modelMetadata,
      selection: model,
    });
    return { model: selection.reference };
  } catch (error) {
    if (error instanceof InvalidRuntimeModelSelectionError) {
      throw new NonRetryableError(
        `ctx.agent("${name}", { model }) could not resolve the model selection: ${toErrorMessage(error)}`,
      );
    }
    throw error;
  }
}

interface AgentModelsTool {
  readonly definition: CompiledBundle["resolvedAgent"]["tools"][number];
  readonly models: NonNullable<ReturnType<typeof readAgentToolModels>>;
}

/** The `agent({ models })` tool whose run opens the session, if that is what opens it. */
async function loadAgentModelsTool(
  bundle: CompiledBundle,
  toolName: string | undefined,
): Promise<AgentModelsTool | undefined> {
  const definition =
    toolName === undefined
      ? undefined
      : bundle.resolvedAgent.tools.find((candidate) => candidate.name === toolName);
  // Only a workflow tool's run opens sessions, and only `agent({ models })` carries models.
  if (definition?.behavior?.handling?.kind !== "workflow-tool") return undefined;
  const models = readAgentToolModels(
    await loadResolvedModuleExport({
      definition,
      kindLabel: "tool",
      moduleMap: bundle.moduleMap,
      nodeId: bundle.nodeId,
    }),
  );
  return models === undefined ? undefined : { definition, models };
}

/**
 * An `agent({ models })` tool names its model by option key. A live model's reference points
 * back at the tool and key, so the child reads the model again from its own module map, and
 * replay opens the same option.
 */
async function resolveAgentToolModel(
  bundle: CompiledBundle,
  { definition, models }: AgentModelsTool,
  model: AgentSessionModelSelection,
): Promise<RuntimeModelReference> {
  const option = typeof model === "string" ? models.get(model) : undefined;
  if (option === undefined) {
    throw new NonRetryableError(
      `The "${definition.name}" tool has no model ${JSON.stringify(model)}. Use one of its agent({ models }) keys, or omit model to use the current model.`,
    );
  }
  let reference: RuntimeModelReference;
  try {
    ({ reference } = await resolveRuntimeModelSelection({
      durability: "live",
      modelMetadata: bundle.modelMetadata,
      selection: option.selection,
    }));
  } catch (error) {
    if (error instanceof InvalidRuntimeModelSelectionError) {
      throw new NonRetryableError(
        `The "${definition.name}" tool could not resolve its model "${option.key}": ${toErrorMessage(error)}`,
      );
    }
    throw error;
  }
  if (typeof selectionModel(option.selection) === "string") return reference;
  return {
    ...reference,
    source: {
      exportName: definition.exportName,
      logicalPath: definition.logicalPath,
      sourceId: definition.sourceId,
      sourceKind: "module",
    },
    sourceModelOption: option.key,
  };
}

export function createParentContext(
  context: AgentSessionContext,
  replyTo: string,
): SubagentParentContext {
  return {
    continuationToken: replyTo,
    conversationId:
      context.trace.conversationId ?? resolveConversationId(context.parent.rootSessionId),
    lineage: context.parent,
    originAudience: context.trace.originAudience,
    traceContext: context.trace.parentTraceContext,
    traceRoot: context.traceRoot,
  };
}

/** The compiled agent whose subagent registry resolves the names `ctx.agent` opens. */
export async function loadAgentSessionBundle(
  context: AgentSessionContext,
): Promise<CompiledBundle> {
  if (context.bundle === undefined) {
    throw new NonRetryableError(
      `ctx.agent() opens the subagents of an agent compiled from files; "${context.agent.id}" is held by this process, not compiled.`,
    );
  }
  return await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource: resolveDurableCompiledArtifactsSource(context.bundle.source),
    nodeId: context.bundle.nodeId,
  });
}
