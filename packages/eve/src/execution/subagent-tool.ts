import { SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter.js";
import { formatSubagentInput } from "#execution/subagent-invocation.js";
import type {
  ChannelInstrumentationProjection,
  RunInput,
  RunSessionLimits,
  SessionAuthContext,
  SessionCapabilities,
} from "#channel/types.js";
import type { HarnessSession } from "#harness/types.js";
import type { JsonObject } from "#shared/json.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";
import { mintSubagentContinuationToken } from "#execution/session.js";
import { resolveSubagentDepth } from "#harness/subagent-depth.js";
import { resolveRemainingSessionTokenLimits } from "#harness/subagent-token-budget.js";

/**
 * Pending runtime-action batch event metadata needed for child run lineage.
 */
interface BatchEventMetadata {
  readonly sequence: number;
  readonly turnId: string;
}

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
export interface SubagentRunInputBuild {
  readonly childContinuationToken: string;
  readonly runInput: RunInput;
}

/**
 * Builds the {@link RunInput} for one delegated subagent child run.
 */
export function buildSubagentRunInput(input: {
  readonly action: RuntimeSubagentCallActionRequest;
  readonly auth: SessionAuthContext | null;
  readonly batchEvent: BatchEventMetadata;
  /**
   * Parent's session capabilities. Forwarded verbatim so HITL
   * readiness flows transparently down through a subagent chain. Undefined
   * parent capabilities produce an undefined child capability set.
   */
  readonly capabilities?: SessionCapabilities;
  readonly channelMetadata?: ChannelInstrumentationProjection;
  /**
   * Number of local subagent calls dispatched in this batch. The parent's
   * remaining token quota is split evenly across them so parallel children
   * are collectively, not individually, bounded by it. Remote agents run
   * under their own deployment's limits and are not counted.
   */
  readonly fanoutSize?: number;
  readonly initiatorAuth: SessionAuthContext | null;
  /** Hook token owned by the workflow currently waiting for this child. */
  readonly parentContinuationToken?: string;
  readonly session: HarnessSession;
  readonly source: SubagentInputSource;
}): SubagentRunInputBuild {
  const {
    action,
    auth,
    batchEvent,
    capabilities,
    channelMetadata,
    initiatorAuth,
    session,
    source,
  } = input;

  const childContinuationToken = mintSubagentContinuationToken(
    `${session.sessionId}:${action.callId}`,
  );

  // Denormalize the chain root onto the child's `parent` metadata so
  // every descendant in a nested dispatch can attribute itself to the
  // top user-facing session in a single hop. A subagent that itself
  // dispatches more subagents reads the root from
  // `session.rootSessionId` here; a top-level session carries no
  // explicit root, so its own `sessionId` becomes the root for its
  // children.
  const rootSessionId = session.rootSessionId ?? session.sessionId;
  const subagentDepth = resolveSubagentDepth(session);
  const inheritedLimits: {
    -readonly [K in keyof RunSessionLimits]: RunSessionLimits[K];
  } = resolveRemainingSessionTokenLimits(session, input.fanoutSize);

  const runInput: {
    -readonly [K in keyof RunInput]: RunInput[K];
  } = {
    adapter: {
      kind: SUBAGENT_ADAPTER_KIND,
      state: {
        callId: action.callId,
        parentContinuationToken: input.parentContinuationToken ?? session.continuationToken,
        parentSessionId: session.sessionId,
        subagentName: action.subagentName,
        ...(action.subagentName === "agent" && session.sandboxState
          ? { parentSandboxState: session.sandboxState, sandboxSessionId: session.sessionId }
          : {}),
      },
    },
    auth,
    capabilities,
    channelMetadata,
    continuationToken: childContinuationToken,
    initiatorAuth,
    input: {
      message: formatSubagentCallInputMessage({ action, source }),
      outputSchema: action.input.outputSchema as JsonObject | undefined,
    },
    limits: inheritedLimits,
    mode: "task",
    parent: {
      callId: action.callId,
      rootSessionId,
      sessionId: session.sessionId,
      turn: {
        id: batchEvent.turnId,
        sequence: batchEvent.sequence,
      },
    },
    subagentDepth: subagentDepth.nextChildDepth,
  };

  return { childContinuationToken, runInput };
}

/**
 * Formats the synthesized child input message for one delegated subagent call.
 */
function formatSubagentCallInputMessage(input: {
  readonly action: Pick<RuntimeSubagentCallActionRequest, "input" | "subagentName">;
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
