import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { AgentStartedStreamEvent, TaskSettledStreamEvent } from "#protocol/message.js";
import type { CallOutcome } from "#protocol/session-events/families/call.js";
import type { InputRequest } from "#shared/input.js";
import { isJsonObjectValue, type JsonObject, type JsonValue } from "#shared/json.js";
import { addTokenUsage, type TokenUsage } from "#shared/token-usage.js";
import type {
  EveEvalDerivedFacts,
  EveEvalSkillLoad,
  EveEvalSubagentCall,
  EveEvalToolCall,
} from "#evals/types.js";

interface MutableToolCall {
  name: string;
  input: JsonObject;
  output: JsonValue | undefined;
  status: EveEvalToolCall["status"];
  turnIndex: number;
  sessionId?: string;
}

type MutableSkillLoad = { -readonly [K in keyof EveEvalSkillLoad]: EveEvalSkillLoad[K] };

/** One call to an agent task, as `task.started` reports it until the work migration. */
interface AgentCall {
  readonly callId: string;
  readonly name: string;
  readonly taskId: string;
  readonly turnIndex: number;
}

export interface DeriveRunFactsOptions {
  /** Session id stamped onto every derived tool call, skill load, and subagent call. */
  readonly sessionId?: string;
  /** Session events through this turn: usage remains the session's total so far. */
  readonly usageEvents?: readonly SessionStreamEvent[];
}

/**
 * Extracts execution facts by explicit identity: a call request and its settlement, completed
 * content, model starts, and usage records. Work events stay on their existing contract until
 * the work migration.
 */
export function deriveRunFacts(
  events: readonly SessionStreamEvent[],
  options?: DeriveRunFactsOptions,
): EveEvalDerivedFacts {
  const sessionId = options?.sessionId;
  const toolCalls: MutableToolCall[] = [];
  const toolCallsByCallId = new Map<string, MutableToolCall>();
  const skillLoads = new Map<string, MutableSkillLoad>();
  const agentCalls: AgentCall[] = [];
  const settledTaskCalls = new Map<string, TaskSettledStreamEvent["data"]>();
  const agentSessions: AgentStartedStreamEvent["data"][] = [];
  const inputRequests: InputRequest[] = [];
  const turnIndexes = new Map<string, number>();
  let turnIndex = -1;
  let messageCount = 0;
  let reasoningBlockCount = 0;
  const models = new Set<string>();
  let failureCode: string | undefined;

  const ensureToolCall = (
    callId: string,
    name: string,
    input: JsonObject,
    index = turnIndex,
  ): MutableToolCall => {
    const existing = toolCallsByCallId.get(callId);
    if (existing !== undefined) return existing;
    const call: MutableToolCall = {
      name,
      input,
      output: undefined,
      status: "pending",
      turnIndex: Math.max(index, 0),
      sessionId,
    };
    toolCalls.push(call);
    toolCallsByCallId.set(callId, call);
    return call;
  };

  for (const event of events) {
    switch (event.type) {
      case "turn.started": {
        if (!turnIndexes.has(event.data.turnId)) {
          turnIndexes.set(event.data.turnId, ++turnIndex);
        }
        break;
      }
      case "call.requested": {
        const { callId, capability, input } = event.data;
        const index =
          event.scope?.turnId === undefined
            ? turnIndex
            : (turnIndexes.get(event.scope.turnId) ?? turnIndex);
        if (capability.kind === "tool") {
          ensureToolCall(callId, capability.name, isJsonObjectValue(input) ? input : {}, index);
        } else if (capability.kind === "skill" && !skillLoads.has(callId)) {
          skillLoads.set(callId, {
            output: undefined,
            sessionId,
            skill: capability.name,
            status: "pending",
            turnIndex: Math.max(index, 0),
          });
        }
        break;
      }
      case "call.settled": {
        const { callId, outcome, output } = event.data;
        const call = toolCallsByCallId.get(callId);
        if (call !== undefined && call.status === "pending") {
          call.output = output;
          call.status = actionStatus(outcome);
        }
        const load = skillLoads.get(callId);
        if (load !== undefined && load.status === "pending") {
          load.output = output;
          load.status = actionStatus(outcome);
        }
        break;
      }
      case "task.started": {
        const { callId, kind, name, taskId } = event.data;
        if (kind === "agent")
          agentCalls.push({ callId, name, taskId, turnIndex: Math.max(turnIndex, 0) });
        break;
      }
      case "task.settled": {
        if (!settledTaskCalls.has(event.data.callId))
          settledTaskCalls.set(event.data.callId, event.data);
        break;
      }
      case "agent.started": {
        agentSessions.push(event.data);
        break;
      }
      case "input.requested": {
        inputRequests.push(...event.data.requests);
        break;
      }
      case "content.completed": {
        if (event.data.kind === "text" && event.data.phase === "reply") messageCount += 1;
        else if (event.data.kind === "reasoning") reasoningBlockCount += 1;
        break;
      }
      case "model.started": {
        models.add(event.data.modelId);
        break;
      }
      case "turn.settled":
      case "session.ended": {
        if (event.data.outcome === "failed") failureCode = event.data.error?.code;
        break;
      }
    }
  }

  const subagentCalls = deriveSubagentCalls({
    agentCalls,
    agentSessions,
    sessionId,
    settledTaskCalls,
  });
  return {
    toolCalls,
    toolCallCount: toolCalls.length,
    skillLoads: [...skillLoads.values()],
    subagentCalls,
    subagentCallCount: subagentCalls.length,
    inputRequests,
    parked: endedParkedOnInput(events),
    messageCount,
    reasoningBlockCount,
    models: [...models],
    usage: sessionUsage(options?.usageEvents ?? events),
    failureCode,
  };
}

function actionStatus(outcome: CallOutcome): EveEvalToolCall["status"] {
  return outcome;
}

/** Sum the immutable usage records once, even if a reconnect reread a commit. */
function sessionUsage(events: readonly SessionStreamEvent[]): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== "usage.recorded") continue;
    const { line, index } = event.meta.position;
    const key = `${line}:${index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total = total === undefined ? event.data.usage : addTokenUsage(total, event.data.usage);
  }
  return total;
}

function deriveSubagentCalls(input: {
  readonly agentCalls: readonly AgentCall[];
  readonly agentSessions: readonly AgentStartedStreamEvent["data"][];
  readonly sessionId: string | undefined;
  readonly settledTaskCalls: ReadonlyMap<string, TaskSettledStreamEvent["data"]>;
}): EveEvalSubagentCall[] {
  const agentSessionsByTaskId = new Map<string, AgentStartedStreamEvent["data"]>();
  for (const session of input.agentSessions) {
    if (session.taskId !== undefined) agentSessionsByTaskId.set(session.taskId, session);
  }
  return input.agentCalls.map((call) => {
    const session = agentSessionsByTaskId.get(call.taskId);
    const settled = input.settledTaskCalls.get(call.callId);
    return {
      callId: call.callId,
      childSessionId: session?.sessionId,
      name: call.name,
      output: settled?.output,
      remoteUrl: session?.remote?.url,
      sessionId: input.sessionId,
      status: settled?.status ?? "working",
      turnIndex: call.turnIndex,
    };
  });
}

export function createEmptyDerivedFacts(): EveEvalDerivedFacts {
  return {
    toolCalls: [],
    toolCallCount: 0,
    skillLoads: [],
    subagentCalls: [],
    subagentCallCount: 0,
    inputRequests: [],
    parked: false,
    messageCount: 0,
    reasoningBlockCount: 0,
    models: [],
  };
}

/** The explicit pause says whether the turn is waiting on a person rather than background work. */
function endedParkedOnInput(events: readonly SessionStreamEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "turn.paused") {
      return event.data.awaiting.some((awaiting) => "interactionId" in awaiting);
    }
    if (event?.type === "turn.settled" || event?.type === "session.ended") return false;
  }
  return false;
}
