import type { MessageContent } from "#shared/message-content.js";
import { SUBAGENT_ADAPTER_KIND } from "#subagents/adapter-state.js";
import { formatSubagentInput, type SubagentParentContext } from "#subagents/invocation.js";
import type { JsonObject } from "#shared/json.js";
import type {
  ChannelInstrumentationProjection,
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

interface SubagentRunInputBuild {
  readonly childContinuationToken: string;
  readonly runInput: RunInput;
}

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

export function buildSubagentRunInput(input: {
  readonly action: RuntimeSubagentDispatchRequest;
  readonly auth: SessionAuthContext | null;
  readonly capabilities?: SessionCapabilities;
  readonly schedule?: import("#context/session-schedule.js").SessionSchedule;
  readonly channelMetadata?: ChannelInstrumentationProjection;
  readonly continuationKey: string;
  readonly inheritedConversation?: ConversationContext;
  readonly initiatorAuth: SessionAuthContext | null;
  readonly graph?: SubagentSandboxGraph;
  readonly sandboxSessionId?: string;
  readonly selfAgent: boolean;
  readonly parent: SubagentParentContext;
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
    schedule: input.schedule,
    channelMetadata,
    inheritedConversation,
    continuationToken: childContinuationToken,
    initiatorAuth,
    input: {
      message: formatSubagentCallInputMessage({
        action,
        source,
      }),
      outputSchema: action.input.outputSchema as JsonObject | undefined,
    },
    conversationId: input.parent.conversationId,
    parent: input.parent.lineage,
    parentTraceContext: input.parent.traceContext,
    traceRoot: input.parent.traceRoot,
  };
  return { childContinuationToken, runInput };
}

function formatSubagentCallInputMessage(input: {
  readonly action: Pick<RuntimeSubagentDispatchRequest, "input" | "subagentName">;
  readonly source: SubagentInputSource;
}): MessageContent<string | URL> {
  const { message } = input.action.input as { message: MessageContent<string | URL> };

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
