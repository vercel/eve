import type { DurableSession } from "#execution/durable-session-store.js";
import type { HarnessSession, SessionToolDefinition } from "#harness/types.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";

const DEFAULT_COMPACTION_RECENT_WINDOW_SIZE = 10;
const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 0.9;
const FALLBACK_COMPACTION_THRESHOLD = 100_000;

/**
 * Creates the durable compaction configuration used by one harness session.
 */
export function createCompactionConfig(
  input: {
    readonly contextWindowTokens?: number;
    readonly lastKnownInputTokens?: number;
    readonly lastKnownPromptMessageCount?: number;
    readonly thresholdPercent?: number;
  } = {},
) {
  const thresholdPercent = input.thresholdPercent ?? DEFAULT_COMPACTION_THRESHOLD_PERCENT;
  const threshold =
    input.contextWindowTokens === undefined
      ? FALLBACK_COMPACTION_THRESHOLD
      : Math.max(1, Math.floor(input.contextWindowTokens * thresholdPercent));

  const config = {
    recentWindowSize: DEFAULT_COMPACTION_RECENT_WINDOW_SIZE,
    threshold,
  };

  if (input.lastKnownInputTokens !== undefined) {
    return {
      ...config,
      lastKnownInputTokens: input.lastKnownInputTokens,
      lastKnownPromptMessageCount: input.lastKnownPromptMessageCount,
    };
  }

  return config;
}

export interface CreateSessionInput {
  readonly continuationToken: string;
  readonly compactionOverrides?: {
    readonly thresholdPercent?: number;
  };
  /**
   * Optional root session id passed in by the runtime when this
   * session is a delegated subagent child. `undefined` for top-level
   * sessions — `sessionId` is the root for those.
   */
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly turnAgent: RuntimeTurnAgent;
  readonly outputSchema?: HarnessSession["outputSchema"];
  readonly subagentDepth?: number;
  readonly subagentMaxDepth?: number;
}

/** Creates a fresh {@link HarnessSession} from the current `turnAgent`. */
export function createSession(input: CreateSessionInput): HarnessSession {
  const { turnAgent } = input;
  const tools = createSessionToolDefinitions(turnAgent);

  const session: {
    -readonly [K in keyof HarnessSession]: HarnessSession[K];
  } = {
    agent: {
      compactionModelReference: turnAgent.compactionModel,
      modelReference: turnAgent.model,
      reasoning: turnAgent.reasoning,
      system: turnAgent.instructions.join("\n\n"),
      tools,
    },
    compaction: createCompactionConfig({
      contextWindowTokens: turnAgent.model.contextWindowTokens,
      thresholdPercent: input.compactionOverrides?.thresholdPercent,
    }),
    continuationToken: input.continuationToken,
    history: [],
    sessionId: input.sessionId,
  };

  if (input.rootSessionId !== undefined) {
    session.rootSessionId = input.rootSessionId;
  }
  if (input.outputSchema !== undefined) {
    session.outputSchema = input.outputSchema;
  }
  if (input.subagentDepth !== undefined) {
    session.subagentDepth = input.subagentDepth;
  }
  if (input.subagentMaxDepth !== undefined) {
    session.subagentMaxDepth = input.subagentMaxDepth;
  }

  return session;
}

/**
 * Refreshes a session with the latest `turnAgent` — replaces the system
 * prompt, model/tool metadata, and compaction thresholds while preserving
 * conversation history and state.
 */
export function refreshSessionFromTurnAgent(input: {
  readonly session: HarnessSession;
  readonly turnAgent: RuntimeTurnAgent;
  readonly compactionOverrides?: {
    readonly thresholdPercent?: number;
  };
}): HarnessSession {
  return {
    ...input.session,
    agent: {
      compactionModelReference: input.turnAgent.compactionModel,
      modelReference: input.turnAgent.model,
      reasoning: input.turnAgent.reasoning,
      system: input.turnAgent.instructions.join("\n\n"),
      tools: createSessionToolDefinitions(input.turnAgent),
    },
    compaction: createCompactionConfig({
      contextWindowTokens: input.turnAgent.model.contextWindowTokens,
      lastKnownInputTokens: input.session.compaction.lastKnownInputTokens,
      lastKnownPromptMessageCount: input.session.compaction.lastKnownPromptMessageCount,
      thresholdPercent: input.compactionOverrides?.thresholdPercent,
    }),
  };
}

/**
 * Mints a continuation token for a delegated subagent session.
 * Deterministic when `suffix` is provided so retries address the same
 * child hook.
 */
export function mintSubagentContinuationToken(suffix?: string): string {
  return `subagent:${suffix ?? crypto.randomUUID()}`;
}

/**
 * Projects a {@link HarnessSession} to {@link DurableSession}.
 *
 * Drops fields rebuilt every turn from `bundle.turnAgent`; keeps
 * `agent.system` and `compaction.lastKnown*` so compaction stays
 * informed after rehydration.
 */
export function projectToDurableSession(session: HarnessSession): DurableSession {
  const durable: {
    agent: { system: string };
    compaction?: {
      lastKnownInputTokens?: number;
      lastKnownPromptMessageCount?: number;
    };
    continuationToken: string;
    history: HarnessSession["history"];
    outputSchema?: HarnessSession["outputSchema"];
    rootSessionId?: string;
    sandboxState?: HarnessSession["sandboxState"];
    sessionId: string;
    state?: HarnessSession["state"];
    subagentDepth?: number;
    subagentMaxDepth?: number;
  } = {
    agent: { system: session.agent.system },
    continuationToken: session.continuationToken,
    history: session.history,
    sessionId: session.sessionId,
  };

  if (
    session.compaction.lastKnownInputTokens !== undefined ||
    session.compaction.lastKnownPromptMessageCount !== undefined
  ) {
    durable.compaction = {
      lastKnownInputTokens: session.compaction.lastKnownInputTokens,
      lastKnownPromptMessageCount: session.compaction.lastKnownPromptMessageCount,
    };
  }
  if (session.rootSessionId !== undefined) {
    durable.rootSessionId = session.rootSessionId;
  }
  if (session.outputSchema !== undefined) {
    durable.outputSchema = session.outputSchema;
  }
  if (session.sandboxState !== undefined) {
    durable.sandboxState = session.sandboxState;
  }
  if (session.state !== undefined) {
    durable.state = session.state;
  }
  if (session.subagentDepth !== undefined) {
    durable.subagentDepth = session.subagentDepth;
  }
  if (session.subagentMaxDepth !== undefined) {
    durable.subagentMaxDepth = session.subagentMaxDepth;
  }

  return durable;
}

/**
 * Rehydrates a {@link HarnessSession} from a {@link DurableSession}
 * plus the current `turnAgent`, rebuilding the runtime-only agent and
 * compaction fields the durable shape omits.
 */
export function hydrateDurableSession(input: {
  readonly durable: DurableSession;
  readonly turnAgent: RuntimeTurnAgent;
  readonly compactionOverrides?: {
    readonly thresholdPercent?: number;
  };
}): HarnessSession {
  const { durable, turnAgent } = input;
  const tools = createSessionToolDefinitions(turnAgent);

  const session: {
    -readonly [K in keyof HarnessSession]: HarnessSession[K];
  } = {
    agent: {
      compactionModelReference: turnAgent.compactionModel,
      modelReference: turnAgent.model,
      reasoning: turnAgent.reasoning,
      system: durable.agent.system,
      tools,
    },
    compaction: createCompactionConfig({
      contextWindowTokens: turnAgent.model.contextWindowTokens,
      lastKnownInputTokens: durable.compaction?.lastKnownInputTokens,
      lastKnownPromptMessageCount: durable.compaction?.lastKnownPromptMessageCount,
      thresholdPercent: input.compactionOverrides?.thresholdPercent,
    }),
    continuationToken: durable.continuationToken,
    history: durable.history,
    sessionId: durable.sessionId,
  };

  if (durable.rootSessionId !== undefined) {
    session.rootSessionId = durable.rootSessionId;
  }
  if (durable.outputSchema !== undefined) {
    session.outputSchema = durable.outputSchema;
  }
  if (durable.sandboxState !== undefined) {
    session.sandboxState = durable.sandboxState;
  }
  if (durable.state !== undefined) {
    session.state = durable.state;
  }
  if (durable.subagentDepth !== undefined) {
    session.subagentDepth = durable.subagentDepth;
  }
  if (durable.subagentMaxDepth !== undefined) {
    session.subagentMaxDepth = durable.subagentMaxDepth;
  }

  return session;
}

function createSessionToolDefinitions(turnAgent: RuntimeTurnAgent): SessionToolDefinition[] {
  return turnAgent.tools.map((tool) => ({
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
    name: tool.name,
    outputSchema: tool.outputSchema,
  }));
}
