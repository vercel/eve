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
 * `action.result` by call id; agent calls join `task.started` with
 * `task.settled` the same way. These facts power checks, scorers, and
 * reporters.
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
  // Model calls whose input matches the agent tool contract, in case their
  // task settles without ever starting a child.
  const agentToolCallsByCallId = new Map<string, { name: string; turnIndex: number }>();
  // Calls that moved to the background: their tool result is a receipt, and
  // only `task.settled` resolves the agent call.
  const detachedCallIds = new Set<string>();
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
        turnIndex += 1;
        break;
      }

      case "actions.requested": {
        for (const action of event.data.actions) {
          if (action.kind === "tool-call") {
            ensureToolCall(action.callId, action.toolName, action.input);
            if (isAgentToolInput(action.input)) {
              agentToolCallsByCallId.set(action.callId, {
                name: action.toolName,
                turnIndex: Math.max(turnIndex, 0),
              });
            }
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
          if (subagentCall?.status === "working" && !detachedCallIds.has(result.callId)) {
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
        const call = ensureSubagentCall(event.data.callId, event.data.name);
        call.taskId = event.data.taskId;
        const child = event.data.child;
        if (child !== undefined) {
          call.childSessionId = child.sessionId;
          if (child.remote !== undefined) call.remoteUrl = child.remote.url;
        }
        break;
      }

      case "task.detached": {
        detachedCallIds.add(event.data.callId);
        break;
      }

      case "task.settled": {
        // Agent tasks join by `task.started`. An agent call that failed or
        // was cancelled before its child started has only `task.settled`;
        // its model call names the agent. The stream cannot tell such a call
        // from a workflow tool with the same input shape that failed to start.
        const unstarted = agentToolCallsByCallId.get(event.data.callId);
        if (!subagentCallsByCallId.has(event.data.callId) && unstarted !== undefined) {
          const created = ensureSubagentCall(event.data.callId, unstarted.name);
          created.taskId = event.data.taskId;
          created.turnIndex = unstarted.turnIndex;
        }
        const call = subagentCallsByCallId.get(event.data.callId);
        if (call?.status !== "working" || call.taskId !== event.data.taskId) break;
        call.output = event.data.status === "failed" ? event.data.error : event.data.output;
        call.status = event.data.status;
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
 * Every agent tool (declared, remote, or built-in `agent`) shares one input
 * contract: a `message`, plus optional `agentId` and `outputSchema`.
 */
function isAgentToolInput(input: JsonObject): boolean {
  return (
    typeof input.message === "string" &&
    Object.keys(input).every((key) => AGENT_TOOL_INPUT_KEYS.has(key))
  );
}

const AGENT_TOOL_INPUT_KEYS = new Set(["agentId", "message", "outputSchema"]);

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
