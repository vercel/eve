import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest } from "#runtime/input/types.js";
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
const TURN_EPILOGUE_EVENT_TYPES: ReadonlySet<HandleMessageStreamEvent["type"]> = new Set([
  "turn.completed",
  "session.waiting",
  "session.completed",
]);

/**
 * Extracts derived execution facts from a completed run's stream events.
 *
 * Tool calls pair each `actions.requested` entry with its matching
 * `action.result` by call id; subagent calls join `subagent.called` /
 * `subagent.started` with `subagent.completed` the same way. These facts
 * power checks, scorers, and reporters.
 */
export function deriveRunFacts(
  events: readonly HandleMessageStreamEvent[],
  options?: DeriveRunFactsOptions,
): EveEvalDerivedFacts {
  const sessionId = options?.sessionId;
  const toolCalls: MutableToolCall[] = [];
  const toolCallsByCallId = new Map<string, MutableToolCall>();
  const subagentCalls: MutableSubagentCall[] = [];
  const subagentCallsByCallId = new Map<string, MutableSubagentCall>();
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
      name,
      status: "pending",
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
        turnIndex += 1;
        break;
      }

      case "actions.requested": {
        for (const action of event.data.actions) {
          if (action.kind !== "tool-call") continue;
          ensureToolCall(action.callId, action.toolName, action.input);
        }
        break;
      }

      case "action.result": {
        const { result, status } = event.data;
        if (result.kind === "tool-result") {
          const call = ensureToolCall(result.callId, result.toolName, {});
          call.output = result.output;
          call.status = status;
        } else if (result.kind === "subagent-result") {
          const call = ensureSubagentCall(result.callId, result.subagentName);
          call.output = call.output ?? result.output;
          call.status = status;
        }
        break;
      }

      case "subagent.called": {
        const call = ensureSubagentCall(event.data.callId, event.data.name);
        if (event.data.remote !== undefined) {
          call.remoteUrl = event.data.remote.url;
        }
        break;
      }

      case "subagent.started": {
        ensureSubagentCall(event.data.callId, event.data.subagentName);
        break;
      }

      case "subagent.completed": {
        const call = ensureSubagentCall(event.data.callId, event.data.subagentName);
        call.output = event.data.output;
        if (call.status === "pending") call.status = "completed";
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
function endedParkedOnInput(events: readonly HandleMessageStreamEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === undefined || TURN_EPILOGUE_EVENT_TYPES.has(event.type)) continue;
    return event.type === "input.requested";
  }
  return false;
}
