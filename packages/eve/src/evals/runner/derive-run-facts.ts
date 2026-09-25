import type { MessageStreamEvent } from "#protocol/message.js";
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

interface MutableSubagentCall {
  callId: string;
  taskId?: string;
  generation?: number;
  ended?: true;
  childSessionId?: string;
  name: string;
  remoteUrl?: string;
  output?: JsonValue;
  status: EveEvalSubagentCall["status"];
  turnIndex: number;
  sessionId?: string;
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
 * `action.result` by call id; agent calls join each generation's
 * `task.started` with its `task.settled` the same way, and `task.ended`
 * marks every call of the task. Interim messages of a held turn are not
 * counted. These facts power checks, scorers, and reporters.
 */
export function deriveRunFacts(
  events: readonly MessageStreamEvent[],
  options?: DeriveRunFactsOptions,
): EveEvalDerivedFacts {
  const sessionId = options?.sessionId;
  const toolCalls: MutableToolCall[] = [];
  const toolCallsByCallId = new Map<string, MutableToolCall>();
  const subagentCalls: MutableSubagentCall[] = [];
  const subagentCallsByCallId = new Map<string, MutableSubagentCall>();
  // Detached calls: their tool result is a receipt, and only `task.settled`
  // resolves the agent call. A remote child reports `task.started` before
  // the receipt.
  const receiptCallIds = new Set<string>();
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

  const ensureSubagentCall = (callId: string, name: string): MutableSubagentCall => {
    const existing = subagentCallsByCallId.get(callId);
    if (existing !== undefined) return existing;

    const call: MutableSubagentCall = {
      callId,
      name,
      status: "working",
      turnIndex: Math.max(turnIndex, 0),
      sessionId,
    };
    subagentCalls.push(call);
    subagentCallsByCallId.set(callId, call);
    return call;
  };

  for (const event of events) {
    switch (event.type) {
      case "turn.started": {
        // A turn that resumes after a waiting boundary keeps its ID and emits
        // no second `turn.started`, so it stays one turn here.
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
          // A model-level agent call resolves as the tool result of the same call ID.
          const subagentCall = subagentCallsByCallId.get(result.callId);
          if (subagentCall?.status === "working" && !receiptCallIds.has(result.callId)) {
            subagentCall.output = subagentCall.output ?? result.output;
            subagentCall.status = status === "completed" ? "completed" : "failed";
          }
        } else if (result.kind === "subagent-result") {
          const call = ensureSubagentCall(result.callId, result.subagentName);
          call.output = call.output ?? result.output;
          if (result.origin === "child" && result.outcome.result.kind === "cancelled") {
            call.status = "cancelled";
          } else {
            call.status = status === "rejected" ? "failed" : status;
          }
        }
        break;
      }

      case "task.started": {
        if (event.data.kind !== "agent") break;
        if (event.data.mode === "detached") receiptCallIds.add(event.data.callId);
        const call = ensureSubagentCall(event.data.callId, event.data.name);
        call.taskId = event.data.taskId;
        call.generation = event.data.generation;
        const child = event.data.child;
        if (child !== undefined) {
          call.childSessionId = child.sessionId;
          if (child.remote !== undefined) call.remoteUrl = child.remote.url;
        }
        break;
      }

      case "task.settled": {
        // Every generation settles after its `task.started`, which named the agent.
        const call = subagentCallsByCallId.get(event.data.callId);
        if (
          call?.status !== "working" ||
          call.taskId !== event.data.taskId ||
          call.generation !== event.data.generation
        ) {
          break;
        }
        call.output = event.data.status === "failed" ? event.data.error : event.data.output;
        call.status = event.data.status;
        break;
      }

      case "task.ended": {
        for (const call of subagentCalls) {
          if (call.taskId === event.data.taskId) call.ended = true;
        }
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
        if (event.data.finishReason !== "tool-calls" && event.data.interim !== true) {
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

  return {
    toolCalls: toolCalls as readonly EveEvalToolCall[],
    toolCallCount: toolCalls.length,
    subagentCalls: subagentCalls as readonly EveEvalSubagentCall[],
    subagentCallCount: subagentCalls.length,
    inputRequests,
    parked: endedParkedOnInput(events),
    messageCount,
    reasoningBlockCount,
    failureCode,
  };
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
