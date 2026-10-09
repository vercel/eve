import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { AgentStartedStreamEvent, TaskSettledStreamEvent } from "#protocol/message.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
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

/** One call to an agent task, as `task.started` reports it. */
interface AgentCall {
  readonly callId: string;
  readonly name: string;
  readonly taskId: string;
  readonly turnIndex: number;
}

/**
 * Options for {@link deriveRunFacts}.
 */
export interface DeriveRunFactsOptions {
  /** Session id stamped onto every derived tool call, skill load, and subagent call. */
  readonly sessionId?: string;
}

/**
 * Event types that only park or close out a turn. When the last meaningful
 * event before them is `input.requested`, the run ended parked on unanswered
 * HITL input.
 */
const PARKING_EVENT_TYPES: ReadonlySet<SessionStreamEvent["type"]> = new Set([
  "turn.waiting",
  "turn.completed",
  "session.waiting",
  "session.completed",
]);

/**
 * Extracts derived execution facts from a completed run's stream events.
 *
 * Tool calls and skill loads pair each `actions.requested` entry with its
 * matching `action.result` by call id. Subagent calls are the calls to agent tasks,
 * paired with their `task.settled` the same way. These facts power checks,
 * scorers, and reporters.
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
  let turnIndex = -1;
  let messageCount = 0;
  let reasoningBlockCount = 0;
  const models = new Set<string>();
  let usage: TokenUsage | undefined;
  let failureCode: string | undefined;

  const ensureToolCall = (callId: string, name: string, input: JsonObject): MutableToolCall => {
    const existing = toolCallsByCallId.get(callId);
    if (existing !== undefined) return existing;

    const call: MutableToolCall = {
      name,
      input,
      output: undefined,
      status: "pending",
      turnIndex: Math.max(turnIndex, 0),
      sessionId,
    };
    toolCalls.push(call);
    toolCallsByCallId.set(callId, call);
    return call;
  };

  for (const event of events) {
    switch (event.type) {
      case "turn.started": {
        turnIndex += 1;
        break;
      }

      case "actions.requested": {
        for (const action of event.data.actions) {
          if (action.kind === "tool-call") {
            ensureToolCall(action.callId, action.toolName, action.input);
          } else if (action.kind === "load-skill") {
            skillLoads.set(action.callId, {
              output: undefined,
              sessionId,
              skill: action.name,
              status: "pending",
              turnIndex: Math.max(turnIndex, 0),
            });
          }
        }
        break;
      }

      case "action.result": {
        const { result, status } = event.data;
        if (result.kind === "tool-result") {
          const call = ensureToolCall(result.callId, result.toolName, {});
          call.output = result.output;
          call.status = status;
        }
        const load =
          result.kind === "load-skill-result" ? skillLoads.get(result.callId) : undefined;
        if (load !== undefined) {
          load.output = result.output;
          load.status = status;
        }
        break;
      }

      case "task.started": {
        const { callId, kind, name, taskId } = event.data;
        if (kind !== "agent") break;
        agentCalls.push({ callId, name, taskId, turnIndex: Math.max(turnIndex, 0) });
        break;
      }

      case "task.settled": {
        settledTaskCalls.set(event.data.callId, event.data);
        break;
      }

      case "agent.started": {
        agentSessions.push(event.data);
        break;
      }

      case "input.requested": {
        inputRequests.push(...event.data.requests);
        for (const request of event.data.requests) {
          ensureToolCall(request.action.callId, request.action.toolName, request.action.input);
        }
        break;
      }

      case "message.completed": {
        if (event.data.finishReason !== "tool-calls") {
          messageCount += 1;
        }
        break;
      }

      case "reasoning.completed": {
        reasoningBlockCount += 1;
        break;
      }

      case "step.started": {
        models.add(event.data.modelId);
        break;
      }

      case "session.waiting":
      case "turn.waiting": {
        usage = event.data.usage;
        break;
      }

      case "session.completed": {
        usage = event.data?.usage;
        break;
      }

      case "session.failed": {
        usage = event.data.usage;
        failureCode = event.data.code;
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
    toolCalls: toolCalls as readonly EveEvalToolCall[],
    toolCallCount: toolCalls.length,
    skillLoads: [...skillLoads.values()],
    subagentCalls,
    subagentCallCount: subagentCalls.length,
    inputRequests,
    parked: endedParkedOnInput(events),
    messageCount,
    reasoningBlockCount,
    models: [...models],
    usage,
    failureCode,
  };
}

/**
 * Every call to an agent task, with its session from the task's
 * `agent.started` once that session opened.
 */
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

/**
 * Returns empty derived facts, used when a case produced no events
 * (execution errors, transport failures).
 */
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

/**
 * A run ended parked when the last event before its parking events is
 * `input.requested`: either the turn ended on the request (`turn.completed` →
 * `session.waiting`), or a call the turn runs asked and the open turn parked
 * (`turn.waiting`).
 */
function endedParkedOnInput(events: readonly SessionStreamEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === undefined || PARKING_EVENT_TYPES.has(event.type)) continue;
    return event.type === "input.requested";
  }
  return false;
}
