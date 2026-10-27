import type { DurableSession } from "#execution/durable-session-store.js";
import { formatAvailableSkillsSection } from "#execution/skills/instructions.js";
import type {
  CompactionConfig,
  CompactionState,
  HarnessSession,
  HarnessSessionBase,
  SessionAgent,
  SessionToolDefinition,
} from "#harness/types.js";
import { compactionThreshold } from "#harness/compaction/measure.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";

const DEFAULT_COMPACTION_RECENT_WINDOW_SIZE = 10;

/**
 * Creates the durable compaction configuration used by one harness session.
 */
export function createCompactionConfig(
  input: {
    readonly contextWindowTokens?: number;
    readonly previous?: CompactionState;
  } = {},
): CompactionConfig {
  const threshold = compactionThreshold(input.contextWindowTokens);

  return {
    ...input.previous,
    recentWindowSize: DEFAULT_COMPACTION_RECENT_WINDOW_SIZE,
    threshold,
  };
}

interface CreateSessionInput {
  readonly continuationToken: string;
  /**
   * Optional root session id passed in by the runtime when this
   * session is a delegated subagent child. `undefined` for top-level
   * sessions — `sessionId` is the root for those.
   */
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly turnAgent: RuntimeTurnAgent;
  readonly outputSchema?: HarnessSession["outputSchema"];
}

/** Creates a fresh {@link HarnessSession} from the current `turnAgent`. */
export function createSession(input: CreateSessionInput): HarnessSession {
  const { turnAgent } = input;
  const tools = createSessionToolDefinitions(turnAgent);

  const session: {
    -readonly [K in keyof HarnessSession]: HarnessSession[K];
  } = {
    agent: createSessionAgent(turnAgent, createSessionSystemPrompt(turnAgent), tools),
    compaction: createCompactionConfig({
      contextWindowTokens: turnAgent.model?.contextWindowTokens,
    }),
    continuationToken: input.continuationToken,
    history: [...(turnAgent.initialMessages ?? [])],
    sessionId: input.sessionId,
  };

  if (input.rootSessionId !== undefined) {
    session.rootSessionId = input.rootSessionId;
  }
  if (input.outputSchema !== undefined) {
    session.outputSchema = input.outputSchema;
  }

  return session;
}

function createSessionAgent(
  turnAgent: RuntimeTurnAgent,
  system: string,
  tools: readonly SessionToolDefinition[],
): SessionAgent {
  const base = {
    reasoning: turnAgent.reasoning,
    system,
    tools,
  };

  if (turnAgent.model !== undefined) {
    return { ...base, modelReference: turnAgent.model };
  }
  if (turnAgent.dynamicModel !== undefined) {
    return { ...base, dynamicModel: true };
  }
  throw new Error("Cannot create a session before dynamic subagent config is selected.");
}

/**
 * Refreshes a session with the latest `turnAgent` — replaces the system
 * prompt, model/tool metadata, and compaction thresholds while preserving
 * conversation history and state.
 */
export function refreshSessionFromTurnAgent(input: {
  readonly session: HarnessSession;
  readonly turnAgent: RuntimeTurnAgent;
}): HarnessSession {
  return {
    ...input.session,
    agent: createSessionAgent(
      input.turnAgent,
      createSessionSystemPrompt(input.turnAgent),
      createSessionToolDefinitions(input.turnAgent),
    ),
    compaction: createCompactionConfig({
      contextWindowTokens: input.turnAgent.model?.contextWindowTokens,
      previous: input.session.compaction,
    }),
  };
}

function createSessionSystemPrompt(turnAgent: RuntimeTurnAgent): string {
  const skillSection = formatAvailableSkillsSection(turnAgent.listedSkills ?? []);
  const blocks =
    skillSection === null ? turnAgent.instructions : [...turnAgent.instructions, skillSection];
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
 * Projects a {@link HarnessSessionBase} to {@link DurableSession}.
 *
 * Drops fields rebuilt every turn from `bundle.turnAgent`; keeps
 * `agent.system` and `compaction.lastKnown*` so compaction stays
 * informed after rehydration.
 */
export function projectToDurableSession(session: HarnessSessionBase): DurableSession {
  const { threshold: _threshold, recentWindowSize: _size, ...measured } = session.compaction;
  return {
    agent: { system: session.agent.system },
    continuationToken: session.continuationToken,
    sessionId: session.sessionId,
    ...(Object.values(measured).some((value) => value !== undefined) && { compaction: measured }),
    ...(session.rootSessionId !== undefined && { rootSessionId: session.rootSessionId }),
    ...(session.outputSchema !== undefined && { outputSchema: session.outputSchema }),
    ...(session.sandboxState !== undefined && { sandboxState: session.sandboxState }),
    ...(session.state !== undefined && { state: session.state }),
  };
}

/**
 * Rehydrates a {@link HarnessSessionBase} from a {@link DurableSession}
 * plus the current `turnAgent`, rebuilding the runtime-only agent and
 * compaction fields the durable shape omits.
 */
export function hydrateDurableSession(input: {
  readonly durable: DurableSession;
  readonly turnAgent: RuntimeTurnAgent;
}): HarnessSessionBase {
  const { durable, turnAgent } = input;
  const { agent, compaction, ...saved } = durable;
  return {
    ...saved,
    agent: createSessionAgent(turnAgent, agent.system, createSessionToolDefinitions(turnAgent)),
    compaction: createCompactionConfig({
      contextWindowTokens: turnAgent.model?.contextWindowTokens,
      previous: compaction,
    }),
  };
}

function createSessionToolDefinitions(turnAgent: RuntimeTurnAgent): SessionToolDefinition[] {
  return turnAgent.tools.map((tool) => ({
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
    name: tool.name,
    outputSchema: tool.outputSchema,
  }));
}
