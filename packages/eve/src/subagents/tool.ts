import { SUBAGENT_ADAPTER_KIND } from "#subagents/adapter-state.js";
import {
  formatSubagentInput,
  normalizeRequestedOutputSchema,
  type SubagentParentContext,
} from "#subagents/invocation.js";
import type {
  ActivityObserverConfig,
  ChannelInstrumentationProjection,
  RunSessionLimits,
  SessionAuthContext,
  SessionCapabilities,
  RunInput,
} from "#channel/types.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeSubagentDispatchRequest } from "#shared/action-types.js";
import { mintSubagentContinuationToken } from "#execution/session.js";
import type { ConversationContext } from "#shared/conversation-context.js";

export type SubagentInputSource =
  | {
      readonly description: string;
      readonly type: "local";
    }
  | {
      readonly type: "runtime";
    };

/**
 * Result of {@link buildSubagentRunInput}.
 *
 * Exposes the derived `childContinuationToken` alongside the
 * {@link RunInput} so dispatch sites never re-derive the token from
 * `(callId, parentSessionId)` on their own.
 */
interface SubagentRunInputBuild {
  readonly childContinuationToken: string;
  readonly runInput: RunInput;
}

/**
 * Runtime graph shape needed to answer sandbox-inheritance questions for
 * one declared child node. Partial test bundles may omit the graph.
 */
export interface SubagentSandboxGraph {
  readonly nodesByNodeId: ReadonlyMap<
    string,
    {
      readonly sandboxRegistry: {
        readonly sandbox: {
          readonly definition: { readonly kind: "independent" | "parent" };
        } | null;
      };
    }
  >;
}

/**
 * Builds the {@link RunInput} for one delegated subagent child run.
 */
export function buildSubagentRunInput(input: {
  readonly action: RuntimeSubagentDispatchRequest;
  readonly auth: SessionAuthContext | null;
  /**
   * Parent's session capabilities. Forwarded verbatim so HITL
   * readiness flows transparently down through a subagent chain. Undefined
   * parent capabilities produce an undefined child capability set.
   */
  readonly capabilities?: SessionCapabilities;
  readonly channelMetadata?: ChannelInstrumentationProjection;
  /** Replay-stable key the child's continuation token derives from. */
  readonly continuationKey: string;
  /** Parent's immutable conversation classification. */
  readonly inheritedConversation?: ConversationContext;
  readonly initiatorAuth: SessionAuthContext | null;
  /**
   * Runtime graph used to detect whether this declared child selected the
   * dispatching parent's sandbox. Absence means no inheritance.
   */
  readonly graph?: SubagentSandboxGraph;
  /** Durable session identity of the sandbox currently used by the parent. */
  readonly sandboxSessionId?: string;
  readonly selfAgent: boolean;
  /** Session token limits the child inherits. */
  readonly limits: RunSessionLimits;
  readonly parent: SubagentParentContext;
  readonly activityObserver?: ActivityObserverConfig;
  readonly session: Pick<HarnessSession, "continuationToken" | "sandboxState" | "sessionId">;
  readonly source: SubagentInputSource;
}): SubagentRunInputBuild {
  const {
    action,
    auth,
    capabilities,
    channelMetadata,
    inheritedConversation,
    initiatorAuth,
    session,
    source,
  } = input;

  const childContinuationToken = mintSubagentContinuationToken(input.continuationKey);
  const requestedOutputSchema = normalizeRequestedOutputSchema(action.input.outputSchema);
  const adapterState: Record<string, unknown> = {
    callId: action.callId,
    parentContinuationToken: input.parent.continuationToken ?? session.continuationToken,
    parentSessionId: session.sessionId,
    subagentName: action.subagentName,
  };
  const reusesOwnerSandbox =
    input.graph?.nodesByNodeId.get(action.nodeId)?.sandboxRegistry.sandbox?.definition.kind ===
      "parent" || input.selfAgent;
  if (reusesOwnerSandbox) {
    if (session.sandboxState !== undefined) {
      adapterState.parentSandboxState = session.sandboxState;
    }
    adapterState.sandboxSessionId = input.sandboxSessionId ?? session.sessionId;
  }

  const runInput: {
    -readonly [K in keyof RunInput]: RunInput[K];
  } = {
    adapter: {
      kind: SUBAGENT_ADAPTER_KIND,
      state: adapterState,
    },
    auth,
    capabilities,
    channelMetadata,
    inheritedConversation,
    continuationToken: childContinuationToken,
    initiatorAuth,
    input: {
      message: formatSubagentCallInputMessage({
        action,
        source,
      }),
      outputSchema: requestedOutputSchema,
    },
    limits: input.limits,
    conversationId: input.parent.conversationId,
    parent: input.parent.lineage,
    parentTraceContext: input.parent.traceContext,
    activityObserver: input.activityObserver,
  };
  return { childContinuationToken, runInput };
}

/**
 * Formats the synthesized child input message for one delegated subagent call.
 */
function formatSubagentCallInputMessage(input: {
  readonly action: Pick<RuntimeSubagentDispatchRequest, "input" | "subagentName">;
  readonly source: SubagentInputSource;
}): string {
  const { message } = input.action.input as { message: string };

  switch (input.source.type) {
    case "local":
      return formatSubagentInput({
        description: input.source.description,
        message,
        name: input.action.subagentName,
        type: "local",
      }).message;
    case "runtime":
      return formatSubagentInput({
        message,
        name: input.action.subagentName,
        type: "runtime",
      }).message;
    default: {
      const _exhaustive: never = input.source;
      return _exhaustive;
    }
  }
}
