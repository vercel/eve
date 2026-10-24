import type {
  AgentStartedStreamEvent,
  MessageStreamEvent,
  TaskSettledStreamEvent,
} from "#protocol/message.js";
import { foldSession, initialSessionProjection, openInputs } from "#protocol/session-projection.js";
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
 * Event types that only park or close out a turn. A run that ends on one while
 * a request is open ended parked on unanswered HITL input.
 */
const PARKING_EVENT_TYPES: ReadonlySet<MessageStreamEvent["type"]> = new Set([
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
  events: readonly MessageStreamEvent[],
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

      case "session.failed": {
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
    usage: latestUsage(events)?.usage,
    failureCode,
  };
}

/**
 * The last event in `events` (in stream order) that carries the session's
 * running usage total (`session.waiting`, `turn.waiting`, `session.failed`, or
 * `session.completed`), with its time, so an eval that captured a session more
 * than once can keep the latest total by time rather than by capture order.
 * `usage` is undefined when that event reported none.
 */
export function latestUsage(
  events: readonly MessageStreamEvent[],
): { readonly usage: TokenUsage | undefined; readonly at: number } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === undefined) continue;
    switch (event.type) {
      case "session.waiting":
      case "turn.waiting":
      case "session.failed":
        return { usage: event.data.usage, at: Date.parse(event.meta.at) };
      case "session.completed":
        return { usage: event.data?.usage, at: Date.parse(event.meta.at) };
    }
  }
  return undefined;
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
 * Input requests the last started turn raised, or a child relayed, that nobody
 * has answered yet. A partial answer settles only the requests it answers; the
 * rest stay open.
 *
 * An eval may watch how a request ends outside the session (for example
 * through `t.target`), so two kinds of open request don't count: the session's
 * own requests from earlier turns, and answered ones whose responder still has
 * to sign in. Relayed requests keep the child's `turnId`, so they never match
 * the parent's turn and are kept by `callId`/`taskId` instead.
 */
export function openInputRequests(events: readonly MessageStreamEvent[]): InputRequest[] {
  let projection = initialSessionProjection();
  let lastTurnId: string | undefined;
  for (const event of events) {
    projection = foldSession(projection, event);
    if (event.type === "turn.started") lastTurnId = event.data.turnId;
  }
  const awaitingSignIn = new Set(
    Object.values(projection.candidates)
      .filter((candidate) => candidate.outcome === "pending")
      .map((candidate) => candidate.requestId),
  );
  return openInputs(projection)
    .filter(
      (input) =>
        lastTurnId === undefined ||
        input.turnId === lastTurnId ||
        input.callId !== undefined ||
        input.taskId !== undefined,
    )
    .filter((input) => !awaitingSignIn.has(input.request.requestId))
    .map((input) => input.request);
}

/**
 * A run ended parked when it ends on a parking event while a request is still
 * open: the turn ended on the request (`turn.completed` → `session.waiting`),
 * or the open turn parked on it (`turn.waiting`), also after a partial answer.
 */
function endedParkedOnInput(events: readonly MessageStreamEvent[]): boolean {
  const last = events.at(-1);
  return (
    last !== undefined && PARKING_EVENT_TYPES.has(last.type) && openInputRequests(events).length > 0
  );
}
