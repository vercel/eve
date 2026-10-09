// Authored hooks, channels, and the session handle's event stream observe the v26 stream events,
// so the authoring API stays as it was until its v27 form is designed. Sessions write v27 facts;
// this module translates each written line, with the session's private projection before and
// after it, into the v26 events the line stands for. It is the only producer of v26 events.
//
// The map, by v27 record:
// - session.started → session.started; session.ended → session.completed or session.failed.
// - turn.started → turn.started; turn.paused → turn.waiting; turn.settled → turn.completed,
//   turn.failed, or turn.cancelled, then session.waiting unless the session ends in the line.
// - delivery.consumed → message.received. A control's settlement between turns, and a context
//   change between turns, → session.waiting.
// - model.started → step.started (compaction.requested for a summary run); model.settled →
//   step.completed or step.failed. An abandoned run (a retried attempt) reports nothing.
// - content.delta → message.appended or reasoning.appended; content.completed → message.completed
//   (narration finishes "tool-calls"), reasoning.completed, or result.completed.
// - call.input → action.input.appended; call.requested → actions.requested; call.progress →
//   action.partial; call.started for a task → task.started and the call's receipt as
//   action.result; call.settled → task.settled for a task's call, otherwise action.result.
// - interaction.opened → input.requested (one per line) or authorization.required;
//   interaction.settled → approval.settled and input.resolved (one per line), or
//   authorization.completed; a refused or expired approval response → approval.candidate.
// - context.settled → compaction.completed or context.cleared; child.opened → agent.started.
// Everything else (task, usage, response bookkeeping, deliveries) has no v26 event.

import {
  requestBatchOf,
  requestSettlementOf,
  signInOutcomeOf,
} from "#channel/interaction-prompts.js";
import { renderTaskReceipt, renderTaskSentReceipt } from "#execution/tasks/render.js";
import { readTaskTable } from "#execution/tasks/table.js";
import type { SessionStateMap } from "#harness/types.js";
import type {
  ActionPresentationByCallId,
  AssistantStepFinishReason,
  MessageReceivedPart,
  MessageStreamEvent,
  TaskCancelReason,
  UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";
import type { UserPart } from "#protocol/session-events/envelope.js";
import type { FactOf, ProgressOf } from "#protocol/session-events/facts.js";
import type { InteractionOpenedData } from "#protocol/session-events/families/interaction.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import { callTask, callTurn, interactionOwner } from "#protocol/session-projection/selectors.js";
import type { CallRow, SessionView } from "#protocol/session-projection/tables.js";
import type { RuntimeActionResult, RuntimeActionRequest } from "#shared/action-types.js";
import type { ConnectionAuthorizationChallenge } from "#connections/errors.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { isJsonObjectValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** One written line, as the translator reads it. */
export interface WrittenLine {
  /** The line's records as readers read them back, in order. */
  readonly events: readonly SessionStreamEvent[];
  readonly position: number;
  readonly at: string;
  /** The session's projection, with its public view, before and after the line. */
  readonly before: SessionProjection;
  readonly after: SessionProjection;
  /** The session's private state after the line, for task receipts. */
  readonly state?: SessionStateMap;
}

export interface LegacyContext {
  readonly sessionId: string;
  /** What `session.waiting` names: the channel's continuation token, or the session's id. */
  readonly continuationToken?: string;
  /** The open turn's delivery ids, stamped on its events. */
  readonly deliveryIds?: readonly string[];
}

/**
 * Translates lines in order. A content part announces its kind, and a call its name, only on
 * its first progress record, so the translator remembers them for the records after it.
 */
export interface LegacyEventTranslator {
  /** The v26 events for each of the line's records, aligned with `line.events`. */
  translate(line: WrittenLine, context: LegacyContext): readonly (readonly MessageStreamEvent[])[];
}

export function createLegacyEventTranslator(): LegacyEventTranslator {
  const partKinds = new Map<string, string>();
  const callNames = new Map<string, string>();
  return {
    translate(line, context) {
      const translation = new LineTranslation(line, context, partKinds, callNames);
      const translated = line.events.map((event) => translation.record(event));
      let k = 0;
      return translated.map((events, index) =>
        events.map((event) => stamp(event, line, index, k++, context)),
      );
    },
  };
}

function stamp(
  event: UnstampedMessageStreamEvent,
  line: WrittenLine,
  index: number,
  k: number,
  context: LegacyContext,
): MessageStreamEvent {
  const id = `ev_${String(line.position).padStart(12, "0")}_${String(index).padStart(4, "0")}_${String(k).padStart(3, "0")}`;
  const meta =
    context.deliveryIds === undefined || context.deliveryIds.length === 0
      ? { at: line.at, id }
      : { at: line.at, deliveryIds: context.deliveryIds, id };
  return { ...event, meta } as MessageStreamEvent;
}

class LineTranslation {
  readonly #line: WrittenLine;
  readonly #context: LegacyContext;
  readonly #partKinds: Map<string, string>;
  readonly #callNames: Map<string, string>;
  readonly #facts: readonly SessionEvent[];
  #inputRequested = false;
  #inputResolved = false;
  #waiting = false;
  #sessionEnds: boolean;

  constructor(
    line: WrittenLine,
    context: LegacyContext,
    partKinds: Map<string, string>,
    callNames: Map<string, string>,
  ) {
    this.#line = line;
    this.#context = context;
    this.#partKinds = partKinds;
    this.#callNames = callNames;
    this.#facts = line.events;
    this.#sessionEnds = line.events.some((event) => event.type === "session.ended");
  }

  get #view(): SessionView | undefined {
    return this.#line.after.view;
  }

  get #previous(): SessionView | undefined {
    return this.#line.before.view;
  }

  record(event: SessionEvent): UnstampedMessageStreamEvent[] {
    switch (event.type) {
      case "session.started":
        return [this.#sessionStarted(event)];
      case "session.ended":
        return [this.#sessionEnded(event)];
      case "turn.started": {
        const started: {
          sequence: number;
          turnId: string;
          trace?: { traceId: string; spanId: string; traceFlags: number };
        } = { sequence: this.#sequence(event.data.turnId), turnId: event.data.turnId };
        if (event.data.trace !== undefined) started.trace = { ...event.data.trace };
        return [{ data: started, type: "turn.started" }];
      }
      case "turn.paused": {
        const on = event.data.awaiting.some((entry) => "interactionId" in entry)
          ? "input"
          : "tasks";
        const data: {
          on: "input" | "tasks";
          sequence: number;
          turnId: string;
          usage?: TokenUsage;
        } = { on, sequence: this.#sequence(event.data.turnId), turnId: event.data.turnId };
        const usage = this.#usage();
        if (usage !== undefined) data.usage = usage;
        return [{ data, type: "turn.waiting" }];
      }
      case "turn.settled":
        return this.#turnSettled(event);
      case "delivery.consumed":
        return [this.#messageReceived(event)];
      case "delivery.settled":
        return this.#controlSettled(event);
      case "model.started":
        return this.#modelStarted(event);
      case "model.settled":
        return this.#modelSettled(event);
      case "content.delta":
        return this.#contentDelta(event);
      case "content.completed":
        return this.#contentCompleted(event);
      case "call.input":
        return this.#callInput(event);
      case "call.requested":
        return this.#callRequested(event);
      case "call.started":
        return this.#callStarted(event);
      case "call.progress":
        return this.#callProgress(event);
      case "call.settled":
        return this.#callSettled(event);
      case "interaction.opened":
        return this.#interactionOpened(event);
      case "interaction.settled":
        return this.#interactionSettled(event);
      case "response.settled":
        return this.#responseSettled(event);
      case "context.settled":
        return this.#contextSettled(event);
      case "child.opened":
        return this.#childOpened(event);
      default:
        return [];
    }
  }

  // ----- sessions and turns ------------------------------------------------------------------

  #sessionStarted(event: FactOf<"session.started">): UnstampedMessageStreamEvent {
    const data: { runtime?: FactOf<"session.started">["data"]["runtime"]; trace?: TraceOf } = {};
    if (event.data.runtime !== undefined) data.runtime = event.data.runtime;
    if (event.data.trace !== undefined) data.trace = { ...event.data.trace };
    return { data, type: "session.started" } as UnstampedMessageStreamEvent;
  }

  #sessionEnded(event: FactOf<"session.ended">): UnstampedMessageStreamEvent {
    const usage = this.#usage();
    if (event.data.outcome === "completed") {
      return usage === undefined
        ? { type: "session.completed" }
        : { data: { usage }, type: "session.completed" };
    }
    const error = event.data.error ?? { code: "SESSION_FAILED", message: "The session failed." };
    const data: {
      code: string;
      details?: JsonObject;
      message: string;
      sessionId: string;
      usage?: TokenUsage;
    } = { code: error.code, message: error.message, sessionId: this.#context.sessionId };
    if (usage !== undefined) data.usage = usage;
    return { data, type: "session.failed" };
  }

  #turnSettled(event: FactOf<"turn.settled">): UnstampedMessageStreamEvent[] {
    const { outcome, turnId } = event.data;
    const sequence = this.#sequence(turnId);
    const events: UnstampedMessageStreamEvent[] = [];
    if (outcome === "completed")
      events.push({ data: { sequence, turnId }, type: "turn.completed" });
    else if (outcome === "cancelled")
      events.push({ data: { sequence, turnId }, type: "turn.cancelled" });
    else {
      const error = event.data.error ?? { code: "TURN_FAILED", message: "The turn failed." };
      const data: {
        code: string;
        details?: JsonObject;
        message: string;
        sequence: number;
        turnId: string;
      } = { code: error.code, message: error.message, sequence, turnId };
      events.push({ data, type: "turn.failed" });
    }
    if (!this.#sessionEnds) events.push(...this.#sessionWaiting());
    return events;
  }

  /** A control the session applied between turns leaves it waiting, as v26 reported. */
  #controlSettled(event: FactOf<"delivery.settled">): UnstampedMessageStreamEvent[] {
    if (this.#sessionEnds || event.data.turnId !== undefined) return [];
    const row =
      this.#view?.deliveries[event.data.deliveryId] ??
      this.#previous?.deliveries[event.data.deliveryId];
    const source = row?.source;
    if (source === undefined || !("control" in source)) return [];
    if (source.control !== "clear" && source.control !== "compact") return [];
    return this.#sessionWaiting();
  }

  #sessionWaiting(): UnstampedMessageStreamEvent[] {
    if (this.#waiting) return [];
    this.#waiting = true;
    const data: {
      continuationToken: string;
      usage?: TokenUsage;
      wait: "next-user-message";
    } = {
      continuationToken: this.#context.continuationToken ?? this.#context.sessionId,
      wait: "next-user-message",
    };
    const usage = this.#usage();
    if (usage !== undefined) data.usage = usage;
    return [{ data, type: "session.waiting" }];
  }

  #messageReceived(event: FactOf<"delivery.consumed">): UnstampedMessageStreamEvent {
    const { parts, turnId } = event.data;
    return {
      data: {
        message: summarize(parts),
        parts: parts.map(receivedPart),
        sequence: this.#sequence(turnId),
        turnId,
      },
      type: "message.received",
    };
  }

  // ----- model runs and content --------------------------------------------------------------

  #modelStarted(event: FactOf<"model.started">): UnstampedMessageStreamEvent[] {
    const run = this.#run(event.data.runId);
    if (run?.changeId !== undefined) {
      const change = this.#view?.changes[run.changeId] ?? this.#previous?.changes[run.changeId];
      if (change?.kind !== "compaction") return [];
      const turnId = change.turnId ?? "";
      return [
        {
          data: {
            modelId: event.data.modelId,
            sequence: turnId === "" ? this.#line.after.nextSequence : this.#sequence(turnId),
            sessionId: this.#context.sessionId,
            stepIndex: turnId === "" ? 0 : this.#turnStep(turnId),
            turnId,
            usageInputTokens: change.trigger?.inputTokens ?? null,
          },
          type: "compaction.requested",
        },
      ];
    }
    if (run?.turnId === undefined) return [];
    return [
      {
        data: {
          modelId: event.data.modelId,
          sequence: this.#sequence(run.turnId),
          stepIndex: run.stepIndex,
          turnId: run.turnId,
        },
        type: "step.started",
      },
    ];
  }

  #modelSettled(event: FactOf<"model.settled">): UnstampedMessageStreamEvent[] {
    const run = this.#run(event.data.runId);
    if (run?.turnId === undefined) return [];
    const at = {
      sequence: this.#sequence(run.turnId),
      stepIndex: run.stepIndex,
      turnId: run.turnId,
    };
    const { outcome } = event.data;
    if (outcome === "abandoned") return [];
    if (outcome === "failed") {
      const error = event.data.error ?? { code: "MODEL_FAILED", message: "The model call failed." };
      const data: Mutable<{
        code: string;
        details?: JsonObject;
        message: string;
        sequence: number;
        stepIndex: number;
        turnId: string;
      }> = { code: error.code, message: error.message, ...at };
      return [{ data, type: "step.failed" }];
    }
    const finishReason: AssistantStepFinishReason =
      outcome === "interrupted" ? "other" : finishReasonOf(event.data.finishReason);
    const data: {
      finishReason: AssistantStepFinishReason;
      providerMetadata?: { readonly gateway: { readonly generationId: string } };
      sequence: number;
      stepIndex: number;
      turnId: string;
      usage?: TokenUsage;
    } = { finishReason, ...at };
    if (event.data.generationId !== undefined)
      data.providerMetadata = { gateway: { generationId: event.data.generationId } };
    const usage =
      this.#view?.runs[event.data.runId]?.usage ?? this.#previous?.runs[event.data.runId]?.usage;
    if (usage !== undefined) data.usage = { ...usage };
    return [{ data, type: "step.completed" } as UnstampedMessageStreamEvent];
  }

  #contentDelta(event: ProgressOf<"content.delta">): UnstampedMessageStreamEvent[] {
    const { delta, kind, partId } = event.data;
    if (kind !== undefined) this.#partKinds.set(partId, kind);
    const known = this.#partKinds.get(partId) ?? this.#view?.parts[partId]?.kind;
    const run = event.scope?.runId === undefined ? undefined : this.#run(event.scope.runId);
    if (run?.turnId === undefined) return [];
    const at = {
      sequence: this.#sequence(run.turnId),
      stepIndex: run.stepIndex,
      turnId: run.turnId,
    };
    if (known === "text")
      return [{ data: { messageDelta: delta, ...at }, type: "message.appended" }];
    if (known === "reasoning")
      return [{ data: { reasoningDelta: delta, ...at }, type: "reasoning.appended" }];
    return [];
  }

  #contentCompleted(event: FactOf<"content.completed">): UnstampedMessageStreamEvent[] {
    const { kind, partId, phase, runId, value } = event.data;
    this.#partKinds.delete(partId);
    const run = this.#run(runId);
    if (run?.turnId === undefined) return [];
    const at = {
      sequence: this.#sequence(run.turnId),
      stepIndex: run.stepIndex,
      turnId: run.turnId,
    };
    if (kind === "reasoning") {
      const reasoning = typeof value === "string" ? value : "";
      return reasoning.length === 0
        ? []
        : [{ data: { reasoning, ...at }, type: "reasoning.completed" }];
    }
    if (kind === "result") {
      return value === undefined
        ? []
        : [{ data: { result: value, ...at }, type: "result.completed" }];
    }
    if (kind !== "text") return [];
    const message = typeof value === "string" ? value : "";
    if (message.length === 0) return [];
    const finishReason: AssistantStepFinishReason =
      phase === "reply" ? this.#runFinishReason(runId) : "tool-calls";
    return [{ data: { finishReason, message, ...at }, type: "message.completed" }];
  }

  /** How a run's reply finished: from its settlement in this line, or as `stop`. */
  #runFinishReason(runId: string): AssistantStepFinishReason {
    const settled = this.#facts.find(
      (fact): fact is FactOf<"model.settled"> =>
        fact.type === "model.settled" && fact.data.runId === runId,
    );
    const reason = settled?.data.finishReason ?? this.#view?.runs[runId]?.finishReason;
    const normalized = finishReasonOf(reason);
    return normalized === "tool-calls" ? "stop" : normalized;
  }

  // ----- calls and tasks ---------------------------------------------------------------------

  #callInput(event: ProgressOf<"call.input">): UnstampedMessageStreamEvent[] {
    const { callId, delta, name } = event.data;
    if (name !== undefined) this.#callNames.set(callId, name);
    const toolName = this.#callNames.get(callId) ?? this.#callRow(callId)?.capability.name;
    const run = event.scope?.runId === undefined ? undefined : this.#run(event.scope.runId);
    if (toolName === undefined || run?.turnId === undefined) return [];
    return [
      {
        data: {
          callId,
          inputTextDelta: delta,
          sequence: this.#sequence(run.turnId),
          stepIndex: run.stepIndex,
          toolName,
          turnId: run.turnId,
        },
        type: "action.input.appended",
      },
    ];
  }

  #callRequested(event: FactOf<"call.requested">): UnstampedMessageStreamEvent[] {
    const { callId, capability } = event.data;
    this.#callNames.delete(callId);
    const row = this.#callRow(callId);
    const at = row === undefined ? undefined : this.#callAt(row);
    if (at === undefined) return [];
    const input = isJsonObjectValue(event.data.input) ? event.data.input : {};
    const action: RuntimeActionRequest =
      capability.kind === "skill"
        ? { callId, input, kind: "load-skill" }
        : { callId, input, kind: "tool-call", toolName: capability.name };
    const data: {
      actions: readonly RuntimeActionRequest[];
      presentation?: ActionPresentationByCallId;
      sequence: number;
      stepIndex: number;
      turnId: string;
    } = { actions: [action], ...at };
    if (capability.title !== undefined)
      data.presentation = { [callId]: { label: capability.title } };
    return [{ data, type: "actions.requested" }];
  }

  /** A call a task serves: the task's start, then the receipt the model read for the call. */
  #callStarted(event: FactOf<"call.started">): UnstampedMessageStreamEvent[] {
    const { callId, taskId } = event.data;
    if (taskId === undefined) return [];
    const row = this.#callRow(callId);
    const task = this.#view?.tasks[taskId] ?? this.#previous?.tasks[taskId];
    const turnId = row === undefined ? undefined : callTurn(this.#view!, row);
    if (row === undefined || task === undefined || turnId === undefined) return [];
    const at = this.#callAt(row) ?? {
      sequence: this.#sequence(turnId),
      stepIndex: this.#turnStep(turnId),
      turnId,
    };
    const startsTask = task.startedBy.callId === callId;
    const resumable =
      readTaskTable(this.#line.state).tasks.find((record) => record.id === taskId)?.resumable ??
      false;
    const receipt = startsTask
      ? renderTaskReceipt({ id: taskId, resumable, tool: task.name })
      : renderTaskSentReceipt(taskId);
    return [
      {
        data: {
          callId,
          kind: task.kind === "agent" ? "agent" : "tool",
          name: task.name,
          taskId,
          turnId: at.turnId,
        },
        type: "task.started",
      },
      {
        data: {
          result: { callId, kind: "tool-result", output: receipt, toolName: row.capability.name },
          status: "completed",
          ...at,
        },
        type: "action.result",
      },
    ];
  }

  #callProgress(event: ProgressOf<"call.progress">): UnstampedMessageStreamEvent[] {
    const { callId, output, title } = event.data;
    const row = this.#callRow(callId);
    const at = row === undefined ? undefined : this.#callAt(row);
    if (row === undefined || at === undefined) return [];
    const data: {
      presentation?: ActionPresentationByCallId;
      result: { callId: string; kind: "tool-result"; output: JsonValue; toolName: string };
      sequence: number;
      stepIndex: number;
      turnId: string;
    } = { result: { callId, kind: "tool-result", output, toolName: row.capability.name }, ...at };
    if (title !== undefined) data.presentation = { [callId]: { label: title } };
    return [{ data, type: "action.partial" }];
  }

  #callSettled(event: FactOf<"call.settled">): UnstampedMessageStreamEvent[] {
    const { callId, outcome } = event.data;
    const row = this.#callRow(callId);
    if (row === undefined) return [];
    const output = this.#outputOf(event.data);
    const taskId = row.taskId ?? callTask(this.#view!, row);
    if (taskId !== undefined && outcome !== "rejected") {
      const task = this.#view?.tasks[taskId] ?? this.#previous?.tasks[taskId];
      const turnId = callTurn(this.#view!, row) ?? this.#callAt(row)?.turnId;
      if (turnId === undefined) return [];
      const base = {
        callId,
        kind: task?.kind === "agent" ? ("agent" as const) : ("tool" as const),
        name: task?.name ?? row.capability.name,
        taskId,
        turnId,
      };
      if (outcome === "completed") {
        const data: Mutable<typeof base> & { output?: JsonValue; status: "completed" } = {
          ...base,
          status: "completed",
        };
        if (output !== undefined) data.output = output;
        return [{ data, type: "task.settled" }];
      }
      if (outcome === "failed") {
        return [
          {
            data: {
              ...base,
              error: { message: event.data.error?.message ?? "The task failed." },
              status: "failed",
            },
            type: "task.settled",
          },
        ];
      }
      const reason = cancelReasonOf(event.data.reason);
      return [
        {
          data:
            reason === undefined
              ? { ...base, status: "cancelled" }
              : { ...base, cancel: { reason }, status: "cancelled" },
          type: "task.settled",
        },
      ];
    }
    const at = this.#callAt(row);
    if (at === undefined) return [];
    const failed = outcome !== "completed";
    const result: RuntimeActionResult =
      row.capability.kind === "skill"
        ? failed
          ? {
              callId,
              isError: true,
              kind: "load-skill-result",
              output: output ?? null,
              name: row.capability.name,
            }
          : { callId, kind: "load-skill-result", output: output ?? null, name: row.capability.name }
        : failed
          ? {
              callId,
              isError: true,
              kind: "tool-result",
              output: output ?? null,
              toolName: row.capability.name,
            }
          : { callId, kind: "tool-result", output: output ?? null, toolName: row.capability.name };
    const status =
      outcome === "completed" ? "completed" : outcome === "rejected" ? "rejected" : "failed";
    const data: {
      error?: { code: string; message: string };
      presentation?: ActionPresentationByCallId;
      result: RuntimeActionResult;
      sequence: number;
      stepIndex: number;
      status: "completed" | "failed" | "rejected";
      turnId: string;
    } = { result, status, ...at };
    if (failed && event.data.error !== undefined)
      data.error = { code: event.data.error.code, message: event.data.error.message };
    if (event.data.title !== undefined)
      data.presentation = { [callId]: { label: event.data.title } };
    return [{ data, type: "action.result" }];
  }

  #outputOf(data: FactOf<"call.settled">["data"]): JsonValue | undefined {
    if (data.output !== undefined) return data.output;
    const seen = new Set<string>();
    let source = data.outputOf?.callId;
    while (source !== undefined && !seen.has(source)) {
      seen.add(source);
      const row = this.#callRow(source);
      if (row?.output !== undefined) return row.output;
      source = row?.outputOf?.callId;
    }
    return undefined;
  }

  // ----- people ------------------------------------------------------------------------------

  #interactionOpened(event: FactOf<"interaction.opened">): UnstampedMessageStreamEvent[] {
    const view = this.#view;
    if (view === undefined) return [];
    if (event.data.request.kind === "sign-in") return [this.#authorizationRequired(event.data)];
    if (this.#inputRequested) return [];
    const batch = requestBatchOf(view, event.data);
    if (batch === undefined) return [];
    this.#inputRequested = true;
    const turnId = batch.turnId || this.#turnOf(event.data.interactionId) || "";
    const data: {
      callId?: string;
      requests: typeof batch.requests;
      sequence: number;
      stepIndex: number;
      taskId?: string;
      turnId: string;
    } = {
      requests: batch.requests,
      sequence: this.#sequence(turnId),
      stepIndex: this.#turnStep(turnId),
      turnId,
    };
    if (batch.callId !== undefined) data.callId = batch.callId;
    if (batch.taskId !== undefined) data.taskId = batch.taskId;
    return [{ data, type: "input.requested" }];
  }

  #authorizationRequired(data: InteractionOpenedData): UnstampedMessageStreamEvent {
    const { interactionId, request, subject } = data;
    const signIn = request.signIn;
    const row = this.#view?.interactions[interactionId];
    const owner = row === undefined ? {} : interactionOwner(this.#view!, row);
    const turnId = owner.turnId ?? ("turnId" in subject ? subject.turnId : "");
    const required: {
      attemptId?: string;
      authorization?: ConnectionAuthorizationChallenge;
      candidateId?: string;
      description: string;
      name: string;
      principalId?: string;
      sequence: number;
      stepIndex: number;
      taskId?: string;
      turnId: string;
      webhookUrl?: string;
    } = {
      attemptId: interactionId,
      description: request.prompt,
      name: signIn?.name ?? interactionId,
      sequence: this.#sequence(turnId),
      stepIndex: this.#turnStep(turnId),
      turnId,
    };
    const challenge = challengeOf(signIn);
    if (challenge !== undefined) required.authorization = challenge;
    if (signIn?.callbackUrl !== undefined) required.webhookUrl = signIn.callbackUrl;
    if ("responseId" in subject) required.candidateId = subject.responseId;
    const principalId = data.audience?.principalIds[0];
    if (principalId !== undefined) required.principalId = principalId;
    if (owner.taskId !== undefined) required.taskId = owner.taskId;
    return { data: required, type: "authorization.required" };
  }

  #interactionSettled(event: FactOf<"interaction.settled">): UnstampedMessageStreamEvent[] {
    const view = this.#view;
    const row = view?.interactions[event.data.interactionId];
    if (view === undefined || row === undefined) return [];
    const turnId = this.#turnOf(row.interactionId) ?? "";
    const at = { sequence: this.#sequence(turnId), stepIndex: this.#turnStep(turnId), turnId };
    if (row.request.kind === "sign-in") {
      const signIn = row.request.signIn;
      const data: {
        attemptId?: string;
        authorization?: ConnectionAuthorizationChallenge;
        candidateId?: string;
        name: string;
        outcome: ReturnType<typeof signInOutcomeOf>;
        principalId?: string;
        reason?: string;
        sequence: number;
        stepIndex: number;
        taskId?: string;
        turnId: string;
      } = {
        attemptId: row.interactionId,
        name: signIn?.name ?? row.interactionId,
        outcome: signInOutcomeOf(event.data.outcome),
        ...at,
      };
      const challenge = challengeOf(signIn);
      if (challenge !== undefined) data.authorization = challenge;
      if ("responseId" in row.subject) data.candidateId = row.subject.responseId;
      const principalId = row.audience?.principalIds[0];
      if (principalId !== undefined) data.principalId = principalId;
      if (event.data.reason !== undefined) data.reason = event.data.reason;
      const taskId = interactionOwner(view, row).taskId;
      if (taskId !== undefined) data.taskId = taskId;
      return [{ data, type: "authorization.completed" }];
    }
    const events: UnstampedMessageStreamEvent[] = [];
    const settlement = requestSettlementOf(view, event.data);
    if (
      settlement?.kind === "tool-approval" &&
      settlement.responder !== undefined &&
      (event.data.outcome === "accepted" || event.data.outcome === "declined")
    ) {
      events.push({
        data: {
          outcome: event.data.outcome === "accepted" ? "approved" : "cancelled",
          requestId: row.interactionId,
          responderPrincipalId: settlement.responder.id,
          ...at,
        },
        type: "approval.settled",
      });
    }
    if (!this.#inputResolved) {
      this.#inputResolved = true;
      const resolutions = this.#facts.flatMap((fact) => {
        if (fact.type !== "interaction.settled") return [];
        const resolved = requestSettlementOf(view, fact.data);
        if (resolved === undefined) return [];
        const resolution: {
          kind: typeof resolved.kind;
          outcome: typeof resolved.outcome;
          requestId: string;
          response?: NonNullable<typeof resolved.response>;
        } = { kind: resolved.kind, outcome: resolved.outcome, requestId: resolved.requestId };
        if (resolved.response !== undefined) resolution.response = resolved.response;
        return [resolution];
      });
      if (resolutions.length > 0)
        events.push({ data: { resolutions, ...at }, type: "input.resolved" });
    }
    return events;
  }

  /** A responder's approval answer a check refused, expired, or set aside. */
  #responseSettled(event: FactOf<"response.settled">): UnstampedMessageStreamEvent[] {
    const view = this.#view;
    const response = view?.responses[event.data.responseId];
    const row = response === undefined ? undefined : view?.interactions[response.interactionId];
    if (view === undefined || response === undefined || row?.request.kind !== "approval") return [];
    const outcome =
      event.data.outcome === "refused"
        ? "rejected"
        : event.data.outcome === "failed"
          ? "failed"
          : event.data.outcome === "expired"
            ? "timed-out"
            : undefined;
    const responder = view.deliveries[response.deliveryId]?.principal;
    if (outcome === undefined || responder === undefined) return [];
    const turnId = this.#turnOf(row.interactionId) ?? "";
    const data: {
      candidateId: string;
      outcome: "rejected" | "failed" | "timed-out";
      reason?: string;
      requestId: string;
      responderPrincipalId: string;
      sequence: number;
      stepIndex: number;
      turnId: string;
    } = {
      candidateId: response.responseId,
      outcome,
      requestId: row.interactionId,
      responderPrincipalId: responder.id,
      sequence: this.#sequence(turnId),
      stepIndex: this.#turnStep(turnId),
      turnId,
    };
    if (event.data.reason !== undefined) data.reason = event.data.reason;
    return [{ data, type: "approval.candidate" }];
  }

  // ----- context and children ----------------------------------------------------------------

  #contextSettled(event: FactOf<"context.settled">): UnstampedMessageStreamEvent[] {
    const { changeId, kind, outcome } = event.data;
    if (outcome !== "completed") return [];
    const change = this.#view?.changes[changeId] ?? this.#previous?.changes[changeId];
    const turnId = change?.turnId ?? "";
    const sequence =
      turnId === "" ? Math.max(0, this.#line.after.nextSequence - 1) : this.#sequence(turnId);
    const events: UnstampedMessageStreamEvent[] = [];
    if (kind === "clear") {
      events.push({
        data: { sequence, sessionId: this.#context.sessionId, turnId },
        type: "context.cleared",
      });
    } else if (kind === "compaction") {
      const run = Object.values(this.#view?.runs ?? {}).find(
        (entry) => "changeId" in entry.owner && entry.owner.changeId === changeId,
      );
      events.push({
        data: {
          modelId: run?.modelId ?? "",
          sequence,
          sessionId: this.#context.sessionId,
          stepIndex: turnId === "" ? 0 : this.#turnStep(turnId),
          turnId,
        },
        type: "compaction.completed",
      });
    } else return [];
    if (turnId === "" && !this.#sessionEnds) events.push(...this.#sessionWaiting());
    return events;
  }

  #childOpened(event: FactOf<"child.opened">): UnstampedMessageStreamEvent[] {
    const { name, owner, sessionId, stream } = event.data;
    const view = this.#view;
    if (view === undefined) return [];
    const taskId = "taskId" in owner ? owner.taskId : undefined;
    const callId = "callId" in owner ? owner.callId : view.tasks[owner.taskId]?.startedBy.callId;
    const row = callId === undefined ? undefined : this.#callRow(callId);
    const turnId =
      row === undefined ? undefined : (callTurn(view, row) ?? this.#callAt(row)?.turnId);
    if (callId === undefined || turnId === undefined) return [];
    const data: {
      callId: string;
      name: string;
      sessionId: string;
      streamPath: string;
      taskId?: string;
      turnId: string;
    } = { callId, name, sessionId, streamPath: stream, turnId };
    const servingTask = taskId ?? (row === undefined ? undefined : callTask(view, row));
    if (servingTask !== undefined) data.taskId = servingTask;
    return [{ data, type: "agent.started" }];
  }

  // ----- coordinates -------------------------------------------------------------------------

  #sequence(turnId: string): number {
    return (
      this.#line.after.turns[turnId]?.sequence ??
      this.#line.before.turns[turnId]?.sequence ??
      turnSequence(turnId) ??
      0
    );
  }

  /** The turn's latest step, as the private turn record keeps it. */
  #turnStep(turnId: string): number {
    return (
      this.#line.after.turns[turnId]?.stepIndex ?? this.#line.before.turns[turnId]?.stepIndex ?? 0
    );
  }

  /** A model run's turn and step, or the context change it summarizes. */
  #run(runId: string): { turnId?: string; stepIndex: number; changeId?: string } | undefined {
    const record = this.#line.before.runs?.[runId] ?? this.#line.after.runs?.[runId];
    const row = this.#view?.runs[runId] ?? this.#previous?.runs[runId];
    const turnId =
      record?.turnId ?? (row !== undefined && "turnId" in row.owner ? row.owner.turnId : undefined);
    const changeId =
      record?.changeId ??
      (row !== undefined && "changeId" in row.owner ? row.owner.changeId : undefined);
    if (turnId === undefined && changeId === undefined) return undefined;
    const run: { turnId?: string; stepIndex: number; changeId?: string } = {
      stepIndex: record?.stepIndex ?? (turnId === undefined ? 0 : this.#turnStep(turnId)),
    };
    if (turnId !== undefined) run.turnId = turnId;
    if (changeId !== undefined) run.changeId = changeId;
    return run;
  }

  #callRow(callId: string): CallRow | undefined {
    return this.#view?.calls[callId] ?? this.#previous?.calls[callId];
  }

  /** Where a call's events go: its run's turn and step, or its parent call's. */
  #callAt(row: CallRow): { sequence: number; stepIndex: number; turnId: string } | undefined {
    const seen = new Set<string>();
    let current: CallRow | undefined = row;
    while (current !== undefined && !seen.has(current.callId)) {
      seen.add(current.callId);
      const record =
        this.#line.after.calls[current.callId] ?? this.#line.before.calls[current.callId];
      if (record !== undefined) {
        return {
          sequence: this.#sequence(record.turnId),
          stepIndex: record.stepIndex,
          turnId: record.turnId,
        };
      }
      if ("runId" in current.owner) {
        const run = this.#run(current.owner.runId);
        if (run?.turnId === undefined) return undefined;
        return {
          sequence: this.#sequence(run.turnId),
          stepIndex: run.stepIndex,
          turnId: run.turnId,
        };
      }
      current = this.#callRow(current.owner.callId);
    }
    const turnId = this.#view === undefined ? undefined : callTurn(this.#view, row);
    return turnId === undefined
      ? undefined
      : { sequence: this.#sequence(turnId), stepIndex: this.#turnStep(turnId), turnId };
  }

  #turnOf(interactionId: string): string | undefined {
    const view = this.#view;
    const row = view?.interactions[interactionId];
    if (view === undefined || row === undefined) return undefined;
    const owner = interactionOwner(view, row);
    if (owner.turnId !== undefined) return owner.turnId;
    if (owner.taskId !== undefined) {
      const task = view.tasks[owner.taskId];
      const starter = task === undefined ? undefined : view.calls[task.startedBy.callId];
      return starter === undefined ? undefined : callTurn(view, starter);
    }
    return undefined;
  }

  #usage(): TokenUsage | undefined {
    const total = this.#view?.usage.total;
    return total === undefined ? undefined : { ...total };
  }
}

type TraceOf = { traceId: string; spanId: string; traceFlags: number };

function turnSequence(turnId: string): number | undefined {
  const match = /^turn_(\d+)$/.exec(turnId);
  return match === null ? undefined : Number(match[1]);
}

const FINISH_REASONS: ReadonlySet<string> = new Set([
  "content-filter",
  "error",
  "length",
  "other",
  "stop",
  "tool-calls",
]);

function finishReasonOf(reason: string | undefined): AssistantStepFinishReason {
  return reason !== undefined && FINISH_REASONS.has(reason)
    ? (reason as AssistantStepFinishReason)
    : "stop";
}

const CANCEL_REASONS: ReadonlySet<string> = new Set([
  "task_cancel",
  "turn_cancelled",
  "turn_ended",
]);

function cancelReasonOf(reason: string | undefined): TaskCancelReason | undefined {
  return reason !== undefined && CANCEL_REASONS.has(reason)
    ? (reason as TaskCancelReason)
    : undefined;
}

function summarize(parts: readonly UserPart[]): string {
  return parts
    .map((part) =>
      part.kind === "text"
        ? part.text
        : `[file: ${part.filename ?? part.mediaType} (${part.mediaType})]`,
    )
    .join("\n");
}

function receivedPart(part: UserPart): MessageReceivedPart {
  if (part.kind === "text") return { text: part.text, type: "text" };
  const file: { filename?: string; mediaType: string; size?: number; type: "file" } = {
    mediaType: part.mediaType,
    type: "file",
  };
  if (part.filename !== undefined) file.filename = part.filename;
  if (part.size !== undefined) file.size = part.size;
  return file;
}

function challengeOf(
  signIn: InteractionOpenedData["request"]["signIn"],
): ConnectionAuthorizationChallenge | undefined {
  if (signIn === undefined) return undefined;
  const challenge: Mutable<ConnectionAuthorizationChallenge> = {};
  if (signIn.url !== undefined) challenge.url = signIn.url;
  if (signIn.userCode !== undefined) challenge.userCode = signIn.userCode;
  if (signIn.expiresAt !== undefined) challenge.expiresAt = signIn.expiresAt;
  if (signIn.instructions !== undefined) challenge.instructions = signIn.instructions;
  if (signIn.displayName !== undefined) challenge.displayName = signIn.displayName;
  return Object.keys(challenge).length === 0 ? undefined : challenge;
}
