// Reads a session an eve before v27 recorded. Those sessions stored one v26 `{type, data, meta}`
// event per line; a v27 deployment shares their World, so it can read their history but not
// their events. This reads each stored v26 event as the v27 commit it records, so every v27
// reader folds the conversation as if v27 had written it: its messages, reasoning, calls and
// their results, approvals and questions, sign-ins, subagents, clears, and compactions.
//
// It reads; it never writes. One stored v26 line reads as at most one v27 line, so positions
// keep their meaning, and a v26 line that records nothing a v27 reader folds reads as none.
// What v26 never recorded, such as a delivery's admission or the end of what a cancel cut, the
// commit that implies it records, the way the v27 writer closes what an owner leaves open.
//
// Delete once no session a v27 deployment serves was recorded before v27.

import { cascade } from "#harness/session-machine/cascade.js";
import { FACT_CATALOG } from "#protocol/session-events/catalog.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";
import {
  type CommitLine,
  type ErrorInfo,
  isStoredLine,
  type JsonValue,
  type StoredLine,
  type UserPart,
} from "#protocol/session-events/envelope.js";
import type { Fact } from "#protocol/session-events/facts.js";
import type { Capability, CallOutcome } from "#protocol/session-events/families/call.js";
import type {
  InteractionOption,
  InteractionOutcome,
  InteractionRequest,
} from "#protocol/session-events/families/interaction.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { createEventReader } from "#protocol/session-lines.js";
import { isV26Line } from "#protocol/v26-lines.js";

type Data = Readonly<Record<string, unknown>>;

/** Reads consecutive stored lines of one session an eve before v27 started, from its first. */
export interface V26HistoryReader {
  /**
   * The v27 line the record at `position` reads as, or `undefined` when it records nothing a v27
   * reader folds, such as a streamed delta. A v27 line reads as itself: a v27 deployment that
   * ends a stranded v26 session appends its end as one.
   */
  read(record: unknown, position: number): StoredLine<SessionEvent> | undefined;
}

/** A reader for one session's stored v26 lines. Read them in order, from position 0. */
export function createV26HistoryReader(): V26HistoryReader {
  const view = emptySessionView();
  const translator = new Translator(view);
  return {
    read(record, position) {
      if (isStoredLine(record)) {
        const line = record as StoredLine<SessionEvent>;
        if ("facts" in line) translator.noteIntroduced(line.facts);
        foldLine(view, line, position, { retention: "operational" });
        return line;
      }
      if (!isV26Line(record)) return undefined;
      const event = record as { readonly type: string; readonly data?: unknown; meta?: unknown };
      const data = isRecord(event.data) ? event.data : {};
      const meta = isRecord(event.meta) ? event.meta : {};
      const at = typeof meta.at === "string" ? meta.at : new Date(0).toISOString();
      const deliveryIds = Array.isArray(meta.deliveryIds)
        ? meta.deliveryIds.filter((id): id is string => typeof id === "string")
        : [];
      const built = translator.factsOf(event.type, data, { deliveryIds, position });
      if (built.length === 0) return undefined;
      // Facts leave out absent fields, as a stored line carries them.
      const intents = JSON.parse(JSON.stringify(built)) as Fact[];
      // The writer's own rule: a commit that ends an owner ends what it still holds.
      const facts = cascade(view, intents);
      const line: CommitLine<SessionEvent> = { at, facts };
      translator.noteIntroduced(facts);
      // As the writer folds: a whole session's settled rows would make each commit cost more.
      foldLine(view, line, position, { retention: "operational" });
      return line;
    },
  };
}

/**
 * The v27 lines a v26 session's stored records read as, from position `from` on: one output per
 * record, a `position` marker for a record that reads as none, so cursors keep counting stored
 * lines. `records` must start at position 0: each record reads in light of those before it.
 */
export function v26LineStream(
  records: ReadableStream<unknown>,
  from: number,
): ReadableStream<unknown> {
  const reader = createV26HistoryReader();
  let position = 0;
  return records.pipeThrough(
    new TransformStream<unknown, unknown>({
      transform(record, controller) {
        const at = position;
        position += 1;
        const line = reader.read(record, at);
        if (at < from) return;
        controller.enqueue(line ?? { $eve: "position", next: at + 1 });
      },
    }),
  );
}

/**
 * The events one session's saved v26 events read as, for an application that kept them: the
 * events a v27 reader of the session's stream would read from them, at the same positions. They
 * must be the session's events from its first, one per stored line, in order, as a v26 client
 * read them from position 0; the next stored line is then at `records.length`. If trailing
 * records emit nothing, the last event's `meta.next` retains that source coverage without
 * changing any event's original position. Save the returned reader metadata unchanged.
 */
export function convertLegacyEvents(records: readonly unknown[]): SessionStreamEvent[] {
  if (!isSessionStarted(records[0])) {
    throw new TypeError(
      "Expected saved events of one session from its first, `session.started`. Each event " +
        "reads in light of those before it, so events saved from a later position can't be " +
        "converted; read the session's stream from position 0 again instead.",
    );
  }
  const history = createV26HistoryReader();
  const reader = createEventReader();
  const events: SessionStreamEvent[] = [];
  records.forEach((record, position) => {
    if (position > 0 && isSessionStarted(record)) {
      throw new TypeError(
        `Saved event ${String(position)} starts another session. Convert each session's ` +
          "events separately: split them where each `session.started` begins.",
      );
    }
    if (!isV26Line(record) || hasStreamPosition(record)) {
      throw new TypeError(
        `Saved event ${String(position)} isn't an event saved before the upgrade to this eve ` +
          "version. Pass only those, as they were saved, one per stored line.",
      );
    }
    const line = history.read(record, position);
    if (line !== undefined) events.push(...reader.read(line, position));
  });
  const last = events.at(-1);
  if (last !== undefined && records.length > last.meta.position.line + 1)
    events[events.length - 1] = { ...last, meta: { ...last.meta, next: records.length } };
  return events;
}

/** A v27 event looks like a v26 one but for the stream position a reader stamped on it. */
function hasStreamPosition(record: unknown): boolean {
  const meta = (record as { readonly meta?: unknown }).meta;
  return isRecord(meta) && meta.position !== undefined;
}

function isSessionStarted(record: unknown): boolean {
  return isV26Line(record) && (record as { readonly type: string }).type === "session.started";
}

interface Context {
  readonly deliveryIds: readonly string[];
  readonly position: number;
}

class Translator {
  /** The turn that runs, as v26 named it. */
  private turnId: string | undefined;
  /** The turn the next one follows; `null` after a clear. */
  private follows: string | null = null;
  /** Each turn's model run per v26 step. */
  private readonly runs = new Map<string, string>();
  private readonly partCounts = new Map<string, number>();
  /** The reply parts of the turn's latest run that replied. */
  private reply: { readonly runId: string; readonly parts: string[] } | undefined;
  /** Calls a task serves: their v26 `action.result` only reports the task starting. */
  private readonly taskCalls = new Set<string>();
  /** The approval that cleared or rejected each call. */
  private readonly approvals = new Map<string, string>();
  private readonly interactionCalls = new Map<string, string>();
  /** The context change a compaction runs as, until it completes. */
  private compaction: string | undefined;
  /** History v26 imported for the turn, for the `delivery.consumed` it records next. */
  private pendingHistory: { id?: string; role: "user" | "assistant"; text: string }[] | undefined;
  /** The delivery `turn.started` admitted, for the message v26 records next. */
  private startingDelivery: string | undefined;

  /** Every entity a commit introduced, by family: the view drops them once they close. */
  private readonly introduced = new Set<string>();

  private readonly view: SessionView;

  constructor(view: SessionView) {
    this.view = view;
  }

  noteIntroduced(facts: readonly SessionEvent[]): void {
    for (const fact of facts) {
      const descriptor = FACT_CATALOG[fact.type as Fact["type"]] as
        | (typeof FACT_CATALOG)[Fact["type"]]
        | undefined;
      if (descriptor?.role !== "introduces") continue;
      const id = (fact.data as Data)[descriptor.idField];
      if (typeof id === "string") this.introduced.add(`${descriptor.family}:${id}`);
    }
  }

  private isIntroduced(family: string, id: string): boolean {
    return this.introduced.has(`${family}:${id}`);
  }

  factsOf(type: string, data: Data, context: Context): Fact[] {
    const id = `v26_${String(context.position)}`;
    switch (type) {
      case "session.started":
        return [{ data: sessionStarted(data), type: "session.started" }];
      case "turn.started":
        return this.startTurn(str(data.turnId), context);
      case "history.imported":
        // Folded into the turn's `delivery.consumed`, which v26 records next.
        this.pendingHistory = Array.isArray(data.messages)
          ? data.messages.flatMap((message) =>
              isRecord(message) &&
              (message.role === "user" || message.role === "assistant") &&
              typeof message.text === "string"
                ? [
                    {
                      id: str(message.id),
                      role: message.role,
                      text: message.text,
                    },
                  ]
                : [],
            )
          : undefined;
        return [];
      case "message.received":
        return this.received(data, context, id);
      case "step.started":
        return this.stepStarted(data, id);
      case "reasoning.completed":
        return this.content(data, "reasoning", "narration", str(data.reasoning), id);
      case "message.completed":
        return this.content(
          data,
          "text",
          data.finishReason === "tool-calls" ? "narration" : "reply",
          str(data.message),
          id,
        );
      case "result.completed":
        return this.content(data, "result", "reply", json(data.result), id);
      case "step.completed":
        return this.stepSettled(data, "completed");
      case "step.failed":
        return this.stepSettled(data, "failed");
      case "actions.requested":
        return this.actionsRequested(data);
      case "action.result":
        return this.actionResult(data);
      case "task.started":
        return this.taskStarted(data);
      case "task.settled":
        return this.taskSettled(data);
      case "agent.started":
        return this.agentStarted(data);
      case "input.requested":
        return this.inputRequested(data);
      case "turn.waiting":
        return this.turnWaiting(data);
      case "input.resolved":
        return this.inputResolved(data, context, id);
      case "authorization.required":
        return this.authorizationRequired(data, id);
      case "authorization.completed":
        return this.authorizationCompleted(data);
      case "turn.completed":
        return this.endTurn(str(data.turnId), { outcome: "completed" });
      case "turn.cancelled":
        return this.endTurn(str(data.turnId), { outcome: "cancelled" });
      case "turn.failed":
        return this.endTurn(str(data.turnId), { error: errorOf(data), outcome: "failed" });
      case "context.cleared":
        this.follows = null;
        return [
          { data: { changeId: id, kind: "clear" }, type: "context.started" },
          {
            data: { changeId: id, kind: "clear", outcome: "completed", selects: null },
            type: "context.settled",
          },
        ];
      case "compaction.requested":
        return this.compactionRequested(data, id);
      case "compaction.completed":
        return this.compactionSettled("completed");
      case "session.waiting":
        // Idle: whatever v26 left open, such as a compaction that failed without an event, ended.
        return this.compaction === undefined ? [] : this.compactionSettled("failed");
      case "session.completed":
        return [{ data: { outcome: "completed" }, type: "session.ended" }];
      case "session.failed":
        return sessionFailed(data, id);
      default:
        // Deltas preview what the completed events record; approval candidates precede the
        // resolution that settles them.
        return [];
    }
  }

  private startTurn(turnId: string | undefined, context: Context): Fact[] {
    if (turnId === undefined || this.isIntroduced("turn", turnId)) return [];
    const facts: Fact[] = [];
    const deliveryId = this.unadmitted(context, `v26_${String(context.position)}`);
    facts.push(...this.admit(deliveryId));
    facts.push({
      data: { cause: { deliveryId }, follows: this.follows, turnId },
      type: "turn.started",
    });
    this.turnId = turnId;
    this.follows = turnId;
    this.reply = undefined;
    this.startingDelivery = deliveryId;
    return facts;
  }

  private received(data: Data, context: Context, id: string): Fact[] {
    const turnId = str(data.turnId);
    if (turnId === undefined) return [];
    const facts = this.isIntroduced("turn", turnId) ? [] : this.startTurn(turnId, context);
    const deliveryId =
      this.startingDelivery !== undefined &&
      this.view.deliveries[this.startingDelivery]?.status === "admitted"
        ? this.startingDelivery
        : this.unadmitted(context, id);
    this.startingDelivery = undefined;
    if (
      !facts.some(
        (fact) => fact.type === "delivery.admitted" && fact.data.deliveryId === deliveryId,
      )
    )
      facts.push(...this.admit(deliveryId));
    const history = this.pendingHistory;
    this.pendingHistory = undefined;
    facts.push({
      data: {
        deliveryId,
        history: history !== undefined && history.length > 0 ? history : undefined,
        parts: userParts(data),
        turnId,
      },
      type: "delivery.consumed",
    });
    return facts;
  }

  /** The first of the line's deliveries v26 named that no turn consumed yet, or `fallback`. */
  private unadmitted(context: Context, fallback: string): string {
    return (
      context.deliveryIds.find(
        (deliveryId) =>
          !this.isIntroduced("delivery", deliveryId) ||
          this.view.deliveries[deliveryId]?.status === "admitted",
      ) ?? fallback
    );
  }

  private admit(deliveryId: string): Fact[] {
    return this.isIntroduced("delivery", deliveryId)
      ? []
      : [{ data: { deliveryId }, type: "delivery.admitted" }];
  }

  private runOf(data: Data): string | undefined {
    const turnId = str(data.turnId);
    if (turnId === undefined || typeof data.stepIndex !== "number") return undefined;
    return this.runs.get(`${turnId}:${String(data.stepIndex)}`);
  }

  private stepStarted(data: Data, id: string): Fact[] {
    const turnId = str(data.turnId);
    if (turnId === undefined || this.view.turns[turnId]?.status !== "running") return [];
    if (typeof data.stepIndex !== "number") return [];
    const key = `${turnId}:${String(data.stepIndex)}`;
    if (this.runs.has(key)) return [];
    const runId = id;
    this.runs.set(key, runId);
    return [
      { data: { owner: { turnId }, runId }, type: "model.requested" },
      {
        data: { attempt: 0, modelId: str(data.modelId) ?? "unknown", runId },
        type: "model.started",
      },
    ];
  }

  private content(
    data: Data,
    kind: string,
    phase: string,
    value: JsonValue | undefined,
    id: string,
  ): Fact[] {
    if (value === undefined) return [];
    // A v26 writer that recorded no `step.started` for the step still names its run.
    const facts = this.runOf(data) === undefined ? this.stepStarted(data, id) : [];
    const runId = this.runOf(data);
    if (runId === undefined || !(this.isOpenRun(runId) || facts.length > 0)) return [];
    const index = this.partCounts.get(runId) ?? 0;
    this.partCounts.set(runId, index + 1);
    const partId = `${runId}.${String(index)}`;
    if (phase === "reply") {
      if (this.reply?.runId !== runId) this.reply = { parts: [], runId };
      this.reply.parts.push(partId);
    }
    return [...facts, { data: { kind, partId, phase, runId, value }, type: "content.completed" }];
  }

  private stepSettled(data: Data, outcome: "completed" | "failed"): Fact[] {
    const runId = this.runOf(data);
    if (runId === undefined || !this.isOpenRun(runId)) return [];
    const facts: Fact[] = [
      {
        data: {
          error: outcome === "failed" ? errorOf(data) : undefined,
          finishReason: typeof data.finishReason === "string" ? data.finishReason : undefined,
          outcome,
          runId,
        },
        type: "model.settled",
      },
    ];
    const usage = isRecord(data.usage) ? data.usage : undefined;
    if (usage !== undefined) {
      facts.push({
        data: {
          kind: "model",
          owner: { runId },
          usage: {
            cacheReadTokens: num(usage.cacheReadTokens),
            cacheWriteTokens: num(usage.cacheWriteTokens),
            costUsd: typeof usage.costUsd === "number" ? usage.costUsd : undefined,
            inputTokens: num(usage.inputTokens),
            outputTokens: num(usage.outputTokens),
          },
        },
        type: "usage.recorded",
      });
    }
    return facts;
  }

  private isOpenRun(runId: string): boolean {
    const status = this.view.runs[runId]?.status;
    return status !== undefined && status !== "settled";
  }

  private actionsRequested(data: Data): Fact[] {
    const runId = this.runOf(data);
    if (runId === undefined || !Array.isArray(data.actions)) return [];
    const presentation = isRecord(data.presentation) ? data.presentation : {};
    return data.actions.flatMap((action): Fact[] => {
      if (!isRecord(action)) return [];
      const callId = str(action.callId);
      if (callId === undefined || this.isIntroduced("call", callId)) return [];
      const shown = isRecord(presentation[callId]) ? presentation[callId] : {};
      const capability = capabilityOf(action, str(shown.label));
      return [
        {
          data: {
            callId,
            capability,
            input: action.input === undefined ? undefined : (action.input as JsonValue),
            owner: { runId },
          },
          type: "call.requested",
        },
      ];
    });
  }

  private startCall(callId: string, taskId?: string): Fact[] {
    if (this.view.calls[callId]?.status !== "requested") return [];
    const interactionId = this.approvals.get(callId);
    return [
      {
        data: {
          callId,
          clearedBy: interactionId === undefined ? undefined : { interactionId },
          taskId: taskId,
        },
        type: "call.started",
      },
    ];
  }

  private actionResult(data: Data): Fact[] {
    const result = isRecord(data.result) ? data.result : {};
    const callId = str(result.callId);
    const row = callId === undefined ? undefined : this.view.calls[callId];
    if (callId === undefined || row === undefined || row.status === "settled") return [];
    // A task serves the call; its `task.settled` carries the call's result.
    if (this.taskCalls.has(callId)) return [];
    const error = isRecord(data.error) ? errorOf(data.error) : undefined;
    if (data.status === "rejected") {
      const interactionId = this.approvals.get(callId);
      return [
        {
          data: {
            callId,
            cause: interactionId === undefined ? undefined : { interactionId },
            error: error,
            outcome: "rejected",
            output: result.output === undefined ? undefined : (result.output as JsonValue),
          },
          type: "call.settled",
        },
      ];
    }
    const outcome: CallOutcome = data.status === "failed" ? "failed" : "completed";
    return [
      ...this.startCall(callId),
      {
        data: {
          callId,
          error: outcome === "failed" && error !== undefined ? error : undefined,
          outcome,
          output: result.output === undefined ? undefined : (result.output as JsonValue),
        },
        type: "call.settled",
      },
    ];
  }

  private taskStarted(data: Data): Fact[] {
    const taskId = str(data.taskId);
    const callId = str(data.callId);
    if (taskId === undefined || callId === undefined || this.view.calls[callId] === undefined)
      return [];
    this.taskCalls.add(callId);
    const facts: Fact[] = [];
    if (!this.isIntroduced("task", taskId)) {
      facts.push({
        data: {
          kind: str(data.kind) ?? "tool",
          name: str(data.name) ?? this.view.calls[callId].capability.name,
          startedBy: { callId },
          taskId,
        },
        type: "task.started",
      });
    }
    facts.push(...this.startCall(callId, taskId));
    return facts;
  }

  private taskSettled(data: Data): Fact[] {
    const callId = str(data.callId);
    const row = callId === undefined ? undefined : this.view.calls[callId];
    if (callId === undefined || row === undefined || row.status === "settled") return [];
    const facts = this.startCall(callId, str(data.taskId));
    const status = data.status;
    const outcome: CallOutcome =
      status === "completed" ? "completed" : status === "failed" ? "failed" : "interrupted";
    const cancel = isRecord(data.cancel) ? str(data.cancel.reason) : undefined;
    facts.push({
      data: {
        callId,
        error:
          isRecord(data.error) && typeof data.error.message === "string"
            ? { code: "task_failed", message: data.error.message }
            : undefined,
        outcome,
        output: data.output === undefined ? undefined : (data.output as JsonValue),
        reason: cancel === undefined ? undefined : cancel.replaceAll("_", "-"),
      },
      type: "call.settled",
    });
    return facts;
  }

  private agentStarted(data: Data): Fact[] {
    const sessionId = str(data.sessionId);
    const callId = str(data.callId);
    if (sessionId === undefined || callId === undefined || this.view.calls[callId] === undefined)
      return [];
    if (this.isIntroduced("child", sessionId)) return [];
    return [
      {
        data: {
          name: str(data.name) ?? this.view.calls[callId].capability.name,
          owner: { callId },
          sessionId,
          stream: str(data.streamPath) ?? `/eve/v1/session/${sessionId}/stream`,
        },
        type: "child.opened",
      },
    ];
  }

  private inputRequested(data: Data): Fact[] {
    if (!Array.isArray(data.requests)) return [];
    const relayedBy = str(data.callId);
    return data.requests.flatMap((request): Fact[] => {
      if (!isRecord(request)) return [];
      const interactionId = str(request.requestId);
      if (interactionId === undefined || this.isIntroduced("interaction", interactionId)) return [];
      const action = isRecord(request.action) ? request.action : {};
      const callId = relayedBy ?? str(action.callId);
      const turnId = str(data.turnId);
      const subject =
        callId !== undefined && this.view.calls[callId] !== undefined
          ? { callId }
          : turnId !== undefined
            ? { turnId }
            : undefined;
      if (subject === undefined) return [];
      if (callId !== undefined && request.kind === "tool-approval")
        this.interactionCalls.set(interactionId, callId);
      return [
        {
          data: { interactionId, request: interactionRequest(request), subject },
          type: "interaction.opened",
        },
      ];
    });
  }

  private turnWaiting(data: Data): Fact[] {
    const turnId = str(data.turnId);
    if (data.on !== "input" || turnId === undefined) return [];
    const awaiting = Object.values(this.view.interactions)
      .filter((row) => row.status === "open")
      .map((row) => ({ interactionId: row.interactionId }));
    if (awaiting.length === 0 || this.view.turns[turnId]?.status !== "running") return [];
    const facts: Fact[] = [{ data: { awaiting, turnId }, type: "turn.paused" }];
    // The deliveries that led here are answered: the turn now waits on a person.
    for (const row of Object.values(this.view.deliveries)) {
      if (row.status === "consumed" && row.turnId === turnId)
        facts.push({
          data: { deliveryId: row.deliveryId, outcome: "awaiting-input", turnId },
          type: "delivery.settled",
        });
    }
    return facts;
  }

  private inputResolved(data: Data, context: Context, id: string): Fact[] {
    if (!Array.isArray(data.resolutions)) return [];
    const turnId = str(data.turnId) ?? this.turnId;
    const deliveryId = this.unadmitted(context, `${id}_answers`);
    const facts: Fact[] = [...this.admit(deliveryId)];
    let answered = false;
    data.resolutions.forEach((resolution, index) => {
      if (!isRecord(resolution)) return;
      const interactionId = str(resolution.requestId);
      if (interactionId === undefined || this.view.interactions[interactionId]?.status !== "open")
        return;
      const answer = isRecord(resolution.response) ? resolution.response : {};
      const value: { optionId?: string; text?: string } = {};
      if (typeof answer.optionId === "string") value.optionId = answer.optionId;
      if (typeof answer.text === "string") value.text = answer.text;
      const outcome = interactionOutcome(resolution.outcome);
      const responseId = `response_${deliveryId}_${String(index)}`;
      answered = true;
      facts.push(
        { data: { deliveryId, interactionId, responseId, value }, type: "response.submitted" },
        { data: { responseId }, type: "response.admitted" },
        { data: { outcome: "applied", responseId }, type: "response.settled" },
        {
          data: {
            cause: { responseId },
            interactionId,
            outcome,
            response: Object.keys(value).length === 0 ? undefined : value,
          },
          type: "interaction.settled",
        },
      );
      const callId = this.interactionCalls.get(interactionId);
      if (callId !== undefined) this.approvals.set(callId, interactionId);
    });
    if (!answered) return [];
    if (turnId !== undefined && this.view.turns[turnId]?.status === "running")
      facts.push({ data: { deliveryId, parts: [], turnId }, type: "delivery.consumed" });
    return facts;
  }

  private authorizationRequired(data: Data, id: string): Fact[] {
    const interactionId = str(data.attemptId) ?? id;
    if (this.isIntroduced("interaction", interactionId)) return [];
    const taskId = str(data.taskId);
    const turnId = str(data.turnId);
    const subject =
      taskId !== undefined && this.view.tasks[taskId] !== undefined
        ? { taskId }
        : turnId !== undefined
          ? { turnId }
          : undefined;
    if (subject === undefined) return [];
    const challenge = isRecord(data.authorization) ? data.authorization : {};
    const name = str(data.name) ?? "sign-in";
    const url = str(challenge.url);
    const request: InteractionRequest = {
      kind: "sign-in",
      link: url === undefined ? undefined : { url },
      prompt: str(data.description) ?? `Sign in to ${name}.`,
      signIn: {
        callbackUrl: str(data.webhookUrl),
        displayName: str(challenge.displayName),
        expiresAt: str(challenge.expiresAt),
        grant: str(data.grant),
        instructions: str(challenge.instructions),
        name,
        principal:
          isRecord(data.principal) && typeof data.principal.type === "string"
            ? {
                id: str(data.principal.id),
                issuer: str(data.principal.issuer),
                type: data.principal.type,
              }
            : undefined,
        url,
        userCode: str(challenge.userCode),
      },
    };
    const principalId = str(data.principalId);
    return [
      {
        data: {
          audience: principalId === undefined ? undefined : { principalIds: [principalId] },
          interactionId,
          request,
          subject,
        },
        type: "interaction.opened",
      },
    ];
  }

  private authorizationCompleted(data: Data): Fact[] {
    const interactionId = str(data.attemptId);
    if (interactionId === undefined || this.view.interactions[interactionId]?.status !== "open")
      return [];
    const outcome: InteractionOutcome =
      data.outcome === "authorized"
        ? "accepted"
        : data.outcome === "declined"
          ? "declined"
          : data.outcome === "timed-out"
            ? "expired"
            : "failed";
    return [
      {
        data: {
          interactionId,
          outcome,
          reason: str(data.reason),
        },
        type: "interaction.settled",
      },
    ];
  }

  private endTurn(
    turnId: string | undefined,
    end: { readonly outcome: "completed" | "cancelled" | "failed"; readonly error?: ErrorInfo },
  ): Fact[] {
    if (turnId === undefined || this.view.turns[turnId]?.status !== "running") return [];
    const reply = end.outcome === "completed" ? this.reply?.parts : undefined;
    this.turnId = undefined;
    this.reply = undefined;
    // `cascade` closes what the turn still holds and settles the deliveries it consumed.
    return [
      {
        data: {
          error: end.error === undefined ? undefined : end.error,
          outcome: end.outcome,
          reply: reply === undefined || reply.length === 0 ? undefined : reply,
          turnId,
        },
        type: "turn.settled",
      },
    ];
  }

  private compactionRequested(data: Data, id: string): Fact[] {
    if (this.compaction !== undefined) return [];
    this.compaction = id;
    const turnId = str(data.turnId);
    const inTurn = turnId !== undefined && this.view.turns[turnId]?.status === "running";
    const inputTokens =
      typeof data.usageInputTokens === "number" ? data.usageInputTokens : undefined;
    return [
      {
        data: {
          changeId: id,
          kind: "compaction",
          trigger: inputTokens === undefined ? undefined : { inputTokens },
          turnId: inTurn ? turnId : undefined,
        },
        type: "context.started",
      },
    ];
  }

  private compactionSettled(outcome: "completed" | "failed"): Fact[] {
    const changeId = this.compaction;
    this.compaction = undefined;
    if (changeId === undefined || this.view.changes[changeId]?.status !== "running") return [];
    return [
      {
        data: {
          changeId,
          error:
            outcome === "failed"
              ? { code: "COMPACTION_FAILED", message: "The compaction did not complete." }
              : undefined,
          kind: "compaction",
          outcome,
        },
        type: "context.settled",
      },
    ];
  }
}

function sessionStarted(data: Data) {
  const invocation = isRecord(data.invocation) ? data.invocation : undefined;
  const parentSessionId = str(invocation?.parentSessionId);
  const parentCallId = str(invocation?.parentCallId);
  const predecessor = isRecord(data.predecessor) ? str(data.predecessor.sessionId) : undefined;
  return {
    parent:
      parentSessionId !== undefined && parentCallId !== undefined
        ? { callId: parentCallId, sessionId: parentSessionId }
        : undefined,
    predecessor: predecessor === undefined ? undefined : { sessionId: predecessor },
    runtime:
      isRecord(data.runtime) && typeof data.runtime.agentId === "string"
        ? (data.runtime as never)
        : undefined,
    trace: isRecord(data.trace) ? (data.trace as never) : undefined,
  };
}

function sessionFailed(data: Data, id: string): Fact[] {
  const error = errorOf(data);
  const details = isRecord(data.details) ? data.details : {};
  // A v26 deployment ending a stranded session recorded what ended it. v27 records a reset as
  // the control delivery it admitted, and names that delivery as the end's cause.
  if (error.code !== "session_stranded" || typeof details.trigger !== "string") {
    return [{ data: { error, outcome: "failed" }, type: "session.ended" }];
  }
  if (details.trigger === "reset") {
    return [
      { data: { deliveryId: id, source: { control: "reset" } }, type: "delivery.admitted" },
      { data: { cause: { deliveryId: id }, error, outcome: "failed" }, type: "session.ended" },
    ];
  }
  return [
    {
      data: { cause: { policy: `stranded-${details.trigger}` }, error, outcome: "failed" },
      type: "session.ended",
    },
  ];
}

function capabilityOf(action: Data, label: string | undefined): Capability {
  const withLabel = label === undefined ? {} : { label };
  switch (action.kind) {
    case "subagent-call":
      return {
        kind: "agent",
        name: str(action.name) ?? str(action.subagentName) ?? "agent",
        ...withLabel,
      };
    case "remote-agent-call":
      return {
        kind: "agent",
        name: str(action.name) ?? str(action.remoteAgentName) ?? "agent",
        remote: true,
        ...withLabel,
      };
    case "load-skill":
      return { kind: "skill", name: str(action.name) ?? "skill", ...withLabel };
    default: {
      const name = str(action.toolName) ?? str(action.name) ?? "tool";
      return { kind: name.startsWith("eve__task_") ? "control" : "tool", name, ...withLabel };
    }
  }
}

function interactionRequest(request: Data): InteractionRequest {
  const kind =
    request.kind === "tool-approval"
      ? "approval"
      : request.kind === "session-limit"
        ? "budget"
        : "question";
  const options = Array.isArray(request.options)
    ? request.options.flatMap((option): InteractionOption[] =>
        isRecord(option) && typeof option.id === "string" && typeof option.label === "string"
          ? [
              {
                id: option.id,
                label: option.label,
                description: str(option.description),
                style:
                  option.style === "primary" ||
                  option.style === "danger" ||
                  option.style === "default"
                    ? option.style
                    : undefined,
              },
            ]
          : [],
      )
    : undefined;
  const display = request.display;
  return {
    allowFreeform: typeof request.allowFreeform === "boolean" ? request.allowFreeform : undefined,
    display:
      display === "confirmation" || display === "select" || display === "text"
        ? display
        : undefined,
    kind,
    options: options,
    prompt: str(request.prompt) ?? "",
  };
}

function interactionOutcome(outcome: unknown): InteractionOutcome {
  switch (outcome) {
    case "answered":
    case "approved":
      return "accepted";
    case "denied":
      return "declined";
    case "invalid":
      return "invalid";
    default:
      // `cancelled` and `ignored`: the request was withdrawn without an answer.
      return "withdrawn";
  }
}

function userParts(data: Data): UserPart[] {
  if (!Array.isArray(data.parts)) {
    return typeof data.message === "string" ? [{ kind: "text", text: data.message }] : [];
  }
  return data.parts.flatMap((part): UserPart[] => {
    if (!isRecord(part)) return [];
    if (part.type === "text" && typeof part.text === "string")
      return [{ kind: "text", text: part.text }];
    if (part.type === "file" && typeof part.mediaType === "string") {
      const url = str(part.url);
      return [
        {
          filename: str(part.filename),
          kind: "file",
          mediaType: part.mediaType,
          size: typeof part.size === "number" ? part.size : undefined,
          // v26 kept no reference to a file's bytes beyond a client-resolvable URL.
          unavailable: url === undefined ? true : undefined,
          url,
        },
      ];
    }
    return [];
  });
}

function errorOf(data: Data): ErrorInfo {
  return {
    code: str(data.code) ?? "unknown",
    message: str(data.message) ?? "Unknown error.",
    name: str(data.name),
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function json(value: unknown): JsonValue | undefined {
  return value === undefined ? undefined : (value as JsonValue);
}

function isRecord(value: unknown): value is Data {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
