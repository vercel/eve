import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { ChildOpenedData } from "#protocol/session-events/families/child.js";
import { emptySessionView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
import { readerInput } from "#protocol/session-reader.js";
import type { TaskStartedData } from "#protocol/session-events/families/task.js";
import type { CallOutcome, CallRequestedData } from "#protocol/session-events/families/call.js";
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
  callId: string;
  name: string;
  input: JsonObject;
  output: JsonValue | undefined;
  status: EveEvalToolCall["status"];
  turnIndex: number;
  sessionId?: string;
}

type MutableSkillLoad = { -readonly [K in keyof EveEvalSkillLoad]: EveEvalSkillLoad[K] };

/** One call served by an agent task, explicitly linked by `call.started`. */
interface AgentCall {
  readonly callId: string;
  readonly name: string;
  readonly taskId: string;
  readonly turnIndex: number;
}

interface AgentCallSettlement {
  readonly status: Exclude<EveEvalSubagentCall["status"], "working">;
  readonly output?: JsonValue;
}

export interface DeriveRunFactsOptions {
  /** Session id stamped onto every derived tool call, skill load, and subagent call. */
  readonly sessionId?: string;
  /** Session events through this turn: cumulative usage and reusable task/child metadata. */
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
  const settledTaskCalls = new Map<string, AgentCallSettlement>();
  // Per-turn captures can call a reusable task started in an earlier turn. Reuse only its
  // identity/child metadata from the captured session, not its old call counts or outcomes.
  const tasks = new Map<string, TaskStartedData>(
    (options?.usageEvents ?? [])
      .filter((event) => event.type === "task.started")
      .map((event) => [event.data.taskId, event.data]),
  );
  // A call a turn settles may have been requested in an earlier segment, as an approved call
  // is. `call.settled` names its call only by id, so the request names it.
  const earlierRequests = new Map<string, CallRequestedData>(
    (options?.usageEvents ?? []).flatMap((event) =>
      event.type === "call.requested" ? [[event.data.callId, event.data] as const] : [],
    ),
  );
  const agentCallIds = new Set<string>();
  const outputs = new Map<string, JsonValue | undefined>();
  const agentSessions: AgentSession[] = (options?.usageEvents ?? []).flatMap((event) =>
    event.type === "child.opened" ? [agentSessionOf(event)] : [],
  );
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
      callId,
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

  // The shared tables rebuild each request with the call it's about.
  const view = emptySessionView();
  for (const event of events) {
    foldReceivedEvent(view, event);
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
        const { callId, outcome, outputOf } = event.data;
        if (outputs.has(callId)) break;
        const output =
          event.data.output !== undefined
            ? event.data.output
            : outputOf === undefined
              ? undefined
              : outputs.get(outputOf.callId);
        outputs.set(callId, output);
        const earlier = earlierRequests.get(callId);
        if (earlier !== undefined && !toolCallsByCallId.has(callId) && !skillLoads.has(callId)) {
          if (earlier.capability.kind === "tool") {
            const input = isJsonObjectValue(earlier.input) ? earlier.input : {};
            ensureToolCall(callId, earlier.capability.name, input);
          } else if (earlier.capability.kind === "skill") {
            skillLoads.set(callId, {
              output: undefined,
              sessionId,
              skill: earlier.capability.name,
              status: "pending",
              turnIndex: Math.max(turnIndex, 0),
            });
          }
        }
        if (agentCallIds.has(callId))
          settledTaskCalls.set(callId, {
            output,
            status:
              outcome === "completed"
                ? "completed"
                : outcome === "interrupted"
                  ? "cancelled"
                  : "failed",
          });
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
        if (!tasks.has(event.data.taskId)) tasks.set(event.data.taskId, event.data);
        break;
      }
      case "call.started": {
        const { callId, taskId } = event.data;
        if (taskId === undefined || agentCallIds.has(callId)) break;
        const task = tasks.get(taskId);
        if (task?.kind !== "agent") break;
        agentCallIds.add(callId);
        const index =
          event.scope?.turnId === undefined
            ? turnIndex
            : (turnIndexes.get(event.scope.turnId) ?? turnIndex);
        agentCalls.push({ callId, name: task.name, taskId, turnIndex: Math.max(index, 0) });
        break;
      }
      case "child.opened": {
        agentSessions.push(agentSessionOf(event));
        break;
      }
      case "interaction.opened": {
        const request = readerInput(view, event.data.interactionId)?.request;
        if (request !== undefined) inputRequests.push(request);
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

/** A session a run opened, by the task whose run opened it. */
interface AgentSession {
  readonly sessionId: string;
  readonly taskId?: string;
}

function agentSessionOf(event: {
  readonly data: ChildOpenedData;
  readonly scope?: { readonly taskId?: string };
}): AgentSession {
  const taskId =
    event.scope?.taskId ?? ("taskId" in event.data.owner ? event.data.owner.taskId : undefined);
  return taskId === undefined
    ? { sessionId: event.data.sessionId }
    : { sessionId: event.data.sessionId, taskId };
}

function deriveSubagentCalls(input: {
  readonly agentCalls: readonly AgentCall[];
  readonly agentSessions: readonly AgentSession[];
  readonly sessionId: string | undefined;
  readonly settledTaskCalls: ReadonlyMap<string, AgentCallSettlement>;
}): EveEvalSubagentCall[] {
  const agentSessionsByTaskId = new Map<string, AgentSession>();
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
