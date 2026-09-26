import type {
  AgentStartedStreamEvent,
  MessageStreamEvent,
  TaskSettledStreamEvent,
} from "#protocol/message.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { EveEvalDerivedFacts, EveEvalSubagentCall, EveEvalToolCall } from "#evals/types.js";

interface MutableToolCall {
  name: string;
  input: JsonObject;
  output: JsonValue | undefined;
  status: EveEvalToolCall["status"];
  turnIndex: number;
  sessionId?: string;
}

/** One call to a task, as `task.started` reports it. */
interface TaskCall {
  readonly callId: string;
  readonly name: string;
  readonly taskId: string;
  readonly turnIndex: number;
}

/**
 * Options for {@link deriveRunFacts}.
 */
export interface DeriveRunFactsOptions {
  /** Session id stamped onto every derived tool and subagent call. */
  readonly sessionId?: string;
}

/**
 * Event types that only close out a turn. When the last meaningful event
 * before this epilogue is `input.requested`, the run ended parked on
 * unanswered HITL input.
 */
const TURN_EPILOGUE_EVENT_TYPES: ReadonlySet<MessageStreamEvent["type"]> = new Set([
  "turn.completed",
  "session.waiting",
  "session.completed",
]);

/**
 * Extracts derived execution facts from a completed run's stream events.
 *
 * Tool calls pair each `actions.requested` entry with its matching
 * `action.result` by call id. Subagent calls are the calls to agent tasks,
 * paired with their `task.settled` the same way. These facts power checks,
 * scorers, and reporters.
 */
export function deriveRunFacts(
  events: readonly MessageStreamEvent[],
  options?: DeriveRunFactsOptions,
): EveEvalDerivedFacts {
  const sessionId = options?.sessionId;
  const toolCalls: MutableToolCall[] = [];
  const toolCallsByCallId = new Map<string, MutableToolCall>();
  const taskCalls: TaskCall[] = [];
  const settledTaskCalls = new Map<string, TaskSettledStreamEvent["data"]>();
  const agentSessionsByCallId = new Map<string, AgentStartedStreamEvent["data"]>();
  const inputRequests: InputRequest[] = [];
  let turnIndex = -1;
  let messageCount = 0;
  let reasoningBlockCount = 0;
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
            ensureToolCall(action.callId, LOAD_SKILL_TOOL_NAME, action.input);
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
        break;
      }

      case "task.started": {
        const { callId, name, taskId } = event.data;
        taskCalls.push({ callId, name, taskId, turnIndex: Math.max(turnIndex, 0) });
        break;
      }

      case "task.settled": {
        settledTaskCalls.set(event.data.callId, event.data);
        break;
      }

      case "agent.started": {
        agentSessionsByCallId.set(event.data.callId, event.data);
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

      case "session.failed": {
        failureCode = event.data.code;
        break;
      }
    }
  }

  const subagentCalls = deriveSubagentCalls({
    agentSessionsByCallId,
    sessionId,
    settledTaskCalls,
    taskCalls,
  });
  return {
    toolCalls: toolCalls as readonly EveEvalToolCall[],
    toolCallCount: toolCalls.length,
    subagentCalls,
    subagentCallCount: subagentCalls.length,
    inputRequests,
    parked: endedParkedOnInput(events),
    messageCount,
    reasoningBlockCount,
    failureCode,
  };
}

/**
 * Every call to an agent task. An agent tool's run opens one session with the
 * agent its task is named after, announced with the task's first call id.
 */
function deriveSubagentCalls(input: {
  readonly agentSessionsByCallId: ReadonlyMap<string, AgentStartedStreamEvent["data"]>;
  readonly sessionId: string | undefined;
  readonly settledTaskCalls: ReadonlyMap<string, TaskSettledStreamEvent["data"]>;
  readonly taskCalls: readonly TaskCall[];
}): EveEvalSubagentCall[] {
  const agentSessionsByTaskId = new Map<string, AgentStartedStreamEvent["data"]>();
  for (const call of input.taskCalls) {
    if (agentSessionsByTaskId.has(call.taskId)) continue;
    const session = input.agentSessionsByCallId.get(call.callId);
    if (session?.name === call.name) agentSessionsByTaskId.set(call.taskId, session);
  }
  return input.taskCalls.flatMap((call) => {
    const session = agentSessionsByTaskId.get(call.taskId);
    if (session === undefined) return [];
    const settled = input.settledTaskCalls.get(call.callId);
    return [
      {
        callId: call.callId,
        childSessionId: session.sessionId,
        name: call.name,
        output: settled?.output,
        remoteUrl: session.remote?.url,
        sessionId: input.sessionId,
        status: settled?.status ?? "working",
        turnIndex: call.turnIndex,
      },
    ];
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
    subagentCalls: [],
    subagentCallCount: 0,
    inputRequests: [],
    parked: false,
    messageCount: 0,
    reasoningBlockCount: 0,
  };
}

/**
 * A run ended parked when the last event before the turn epilogue
 * (`turn.completed` → `session.waiting`) is `input.requested`: the harness
 * surfaced HITL requests and stopped without resolving them.
 */
function endedParkedOnInput(events: readonly MessageStreamEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === undefined || TURN_EPILOGUE_EVENT_TYPES.has(event.type)) continue;
    return event.type === "input.requested";
  }
  return false;
}
