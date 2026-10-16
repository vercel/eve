import type { SessionStreamEvent } from "#protocol/session-event.js";
import { emptySessionView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
import { callOutputSource } from "#protocol/session-projection/selectors.js";
import type { CallRow } from "#protocol/session-projection/tables.js";
import { ownerOf } from "#protocol/session-projection/tree.js";
import { interaction, type Interaction } from "#protocol/session-reader.js";
import { isJsonObjectValue } from "#shared/json.js";
import type {
  EveEvalDerivedFacts,
  EveEvalSkillLoad,
  EveEvalSubagentCall,
  EveEvalToolCall,
} from "#evals/types.js";

export interface DeriveRunFactsOptions {
  /** Session id stamped onto every derived tool call, skill load, and subagent call. */
  readonly sessionId?: string;
  /** Session events through this turn: cumulative usage and reusable task/child metadata. */
  readonly usageEvents?: readonly SessionStreamEvent[];
}

/**
 * What a segment of a session's events did: its tool calls, skill loads and subagent calls, the
 * requests it opened, its content and models, read from the session's tables as the segment
 * leaves them. A call counts when the segment requested or settled it, as an approved call
 * requested in an earlier segment is; a subagent call when the segment started it on its task.
 */
export function deriveRunFacts(
  events: readonly SessionStreamEvent[],
  options?: DeriveRunFactsOptions,
): EveEvalDerivedFacts {
  const sessionId = options?.sessionId;
  const view = emptySessionView();
  // Readers of one session, such as a turn's and a steering message's, record its lines in the
  // order each read them; the fold skips a line behind the last it read, so it reads them in
  // stream order.
  const folded = [...(options?.usageEvents ?? events)].sort(
    (a, b) =>
      a.meta.position.line - b.meta.position.line || a.meta.position.index - b.meta.position.index,
  );
  for (const event of folded) foldReceivedEvent(view, event);

  // The turn each call happened in, in the order the segment first reports it.
  const callTurns = new Map<string, number>();
  const agentCalls = new Map<string, number>();
  const interactions: Interaction[] = [];
  const turnIndexes = new Map<string, number>();
  const models = new Set<string>();
  let messageCount = 0;
  let reasoningBlockCount = 0;
  let failureCode: string | undefined;
  const indexOf = (turnId: string | undefined) =>
    Math.max(
      (turnId === undefined ? undefined : turnIndexes.get(turnId)) ?? turnIndexes.size - 1,
      0,
    );
  for (const event of events) {
    switch (event.type) {
      case "turn.started":
        if (!turnIndexes.has(event.data.turnId))
          turnIndexes.set(event.data.turnId, turnIndexes.size);
        break;
      case "call.requested":
        if (!callTurns.has(event.data.callId))
          callTurns.set(event.data.callId, indexOf(event.scope?.turnId));
        break;
      case "call.settled":
        if (!callTurns.has(event.data.callId)) callTurns.set(event.data.callId, indexOf(undefined));
        break;
      case "call.started": {
        const { callId, taskId } = event.data;
        if (taskId !== undefined && view.tasks[taskId]?.kind === "agent" && !agentCalls.has(callId))
          agentCalls.set(callId, indexOf(event.scope?.turnId));
        break;
      }
      case "interaction.opened": {
        const request = interaction(view, event.data.interactionId);
        if (request !== undefined) interactions.push(request);
        break;
      }
      case "content.completed":
        if (event.data.kind === "text" && event.data.phase === "reply") messageCount += 1;
        else if (event.data.kind === "reasoning") reasoningBlockCount += 1;
        break;
      case "model.started":
        models.add(event.data.modelId);
        break;
      case "turn.settled":
      case "session.ended":
        if (event.data.outcome === "failed") failureCode = event.data.error?.code;
        break;
    }
  }

  // A settled call's status is its outcome, and its output the one it carries or shares.
  const settled = (row: CallRow) =>
    row.status === "settled"
      ? { output: callOutputSource(view, row.callId)?.output, status: row.outcome ?? "failed" }
      : { output: undefined, status: "pending" as const };
  const toolCalls: EveEvalToolCall[] = [];
  const skillLoads: EveEvalSkillLoad[] = [];
  for (const [callId, turnIndex] of callTurns) {
    const row = view.calls[callId];
    if (row === undefined) continue;
    if (row.capability.kind === "skill") {
      skillLoads.push({ sessionId, skill: row.capability.name, turnIndex, ...settled(row) });
      continue;
    }
    // Every other call is a tool the model called by name: a tool, an agent or a task control.
    const input = isJsonObjectValue(row.input) ? row.input : {};
    toolCalls.push({
      callId,
      input,
      name: row.capability.name,
      sessionId,
      turnIndex,
      ...settled(row),
    });
  }
  const subagentCalls = [...agentCalls].flatMap(([callId, turnIndex]): EveEvalSubagentCall[] => {
    const row = view.calls[callId];
    const task = row?.taskId === undefined ? undefined : view.tasks[row.taskId];
    if (row === undefined || task === undefined) return [];
    const child = Object.values(view.children)
      .filter(
        (entry) => ownerOf(view, { family: "child", id: entry.sessionId }, "task") === task.taskId,
      )
      .at(-1);
    return [
      {
        callId,
        childSessionId: child?.sessionId,
        name: task.name,
        sessionId,
        turnIndex,
        ...settled(row),
      },
    ];
  });
  const spent = Object.keys(view.usage.byKind).length > 0 ? view.usage.total : undefined;
  return {
    toolCalls,
    toolCallCount: toolCalls.length,
    skillLoads,
    subagentCalls,
    subagentCallCount: subagentCalls.length,
    interactions,
    parked: endedParkedOnInput(events),
    messageCount,
    reasoningBlockCount,
    models: [...models],
    usage: spent,
    failureCode,
  };
}

export function createEmptyDerivedFacts(): EveEvalDerivedFacts {
  return {
    toolCalls: [],
    toolCallCount: 0,
    skillLoads: [],
    subagentCalls: [],
    subagentCallCount: 0,
    interactions: [],
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
