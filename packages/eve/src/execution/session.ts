import type { DurableSession } from "#execution/durable-session-store.js";
import { formatAvailableSkillsSection } from "#execution/skills/instructions.js";
import type { HarnessSession, SessionLimits, SessionToolDefinition } from "#harness/types.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";

const DEFAULT_COMPACTION_RECENT_WINDOW_SIZE = 10;
const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 0.9;
const FALLBACK_COMPACTION_THRESHOLD = 100_000;
export const DEFAULT_ROOT_MAX_INPUT_TOKENS_PER_SESSION = 40_000_000;

/**
 * Authored session token limits before resolution. `false` means the author
 * explicitly uncapped the axis (skipping the root default). Resolution maps
 * this shape onto the numeric {@link SessionLimits} the harness checks.
 */
export interface AuthoredSessionLimits {
  readonly maxInputTokensPerSession?: number | false;
  readonly maxOutputTokensPerSession?: number | false;
}

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
  readonly limits?: AuthoredSessionLimits;
  readonly outputSchema?: HarnessSession["outputSchema"];
  readonly skillRoot?: string;
  readonly subagentDepth?: number;
  readonly workflowMaxSubagents?: number;
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
      dynamicModelDefaultReference:
        turnAgent.dynamicModel === undefined ? undefined : turnAgent.model,
      modelReference: turnAgent.model,
      reasoning: turnAgent.reasoning,
      system: createSessionSystemPrompt({
        skillRoot: input.skillRoot,
        turnAgent,
      }),
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
  session.limits = resolveSessionLimits(input);
  if (input.outputSchema !== undefined) {
    session.outputSchema = input.outputSchema;
  }
  if (input.subagentDepth !== undefined) {
    session.subagentDepth = input.subagentDepth;
  }
  if (input.workflowMaxSubagents !== undefined) {
    session.workflowMaxSubagents = input.workflowMaxSubagents;
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
  readonly skillRoot?: string;
}): HarnessSession {
  return {
    ...input.session,
    agent: {
      compactionModelReference: input.turnAgent.compactionModel,
      dynamicModelDefaultReference:
        input.turnAgent.dynamicModel === undefined ? undefined : input.turnAgent.model,
      modelReference: input.turnAgent.model,
      reasoning: input.turnAgent.reasoning,
      system: createSessionSystemPrompt({
        skillRoot: input.skillRoot,
        turnAgent: input.turnAgent,
      }),
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

function createSessionSystemPrompt(input: {
  readonly skillRoot?: string;
  readonly turnAgent: RuntimeTurnAgent;
}): string {
  const skillSection = formatAvailableSkillsSection(input.turnAgent.availableSkills ?? [], {
    skillRoot: input.skillRoot,
  });
  const blocks =
    skillSection === null
      ? input.turnAgent.instructions
      : [...input.turnAgent.instructions, skillSection];
  return blocks.join("\n\n");
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
    limits?: HarnessSession["limits"];
    outputSchema?: HarnessSession["outputSchema"];
    rootSessionId?: string;
    sandboxState?: HarnessSession["sandboxState"];
    sessionId: string;
    state?: HarnessSession["state"];
    subagentDepth?: number;
    workflowMaxSubagents?: number;
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
  if (session.limits !== undefined) {
    durable.limits = session.limits;
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
  if (session.workflowMaxSubagents !== undefined) {
    durable.workflowMaxSubagents = session.workflowMaxSubagents;
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
      dynamicModelDefaultReference:
        turnAgent.dynamicModel === undefined ? undefined : turnAgent.model,
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
  // Persisted limits are already resolved (defaults, `false`, and any
  // inherited parent budget applied at creation). Rehydrating verbatim keeps
  // an uncapped session uncapped instead of re-applying the root default.
  if (durable.limits !== undefined) {
    session.limits = durable.limits;
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
  if (durable.workflowMaxSubagents !== undefined) {
    session.workflowMaxSubagents = durable.workflowMaxSubagents;
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

function resolveSessionLimits(input: {
  readonly limits?: AuthoredSessionLimits;
  readonly subagentDepth?: number;
}): SessionLimits {
  const isSubagent = input.subagentDepth !== undefined && input.subagentDepth > 0;

  const maxInputTokensPerSession = resolveSessionTokenLimit({
    authored: input.limits?.maxInputTokensPerSession,
    // Subagents have no fixed default: uncapped parents delegate uncapped
    // children, capped parents delegate their remaining quota (inherited).
    fallback: isSubagent ? undefined : DEFAULT_ROOT_MAX_INPUT_TOKENS_PER_SESSION,
  });
  const maxOutputTokensPerSession = resolveSessionTokenLimit({
    authored: input.limits?.maxOutputTokensPerSession,
    fallback: undefined,
  });

  const limits: { maxInputTokensPerSession?: number; maxOutputTokensPerSession?: number } = {};
  if (maxInputTokensPerSession !== undefined) {
    limits.maxInputTokensPerSession = maxInputTokensPerSession;
  }
  if (maxOutputTokensPerSession !== undefined) {
    limits.maxOutputTokensPerSession = maxOutputTokensPerSession;
  }
  return limits;
}

function resolveSessionTokenLimit(input: {
  readonly authored: number | false | undefined;
  readonly fallback: number | undefined;
}): number | undefined {
  return input.authored === false ? undefined : (input.authored ?? input.fallback);
}
