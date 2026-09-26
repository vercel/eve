/**
 * The subagent child-stream subsystem: for every call to an agent task on
 * the parent stream, a parallel pump over the agent's session folds its
 * events into the renderer's nested subagent view. Extracted from the runner —
 * the subsystem touches nothing but its own run state, the client, and the
 * {@link SubagentView} seam.
 */

import type { Client, StreamReconnectPolicy } from "#client/index.js";
import {
  isCurrentTurnBoundaryEvent,
  type ActionResultStreamEvent,
  type AgentStartedStreamEvent,
  type MessageStreamEvent,
  type TaskStartedStreamEvent,
} from "#protocol/message.js";

/**
 * Pumps end on the child boundary or abort, never on a retry budget: a child
 * parked for HITL can stay silent indefinitely, and the dev server can restart
 * underneath an open follower.
 */
const childStreamReconnectPolicy = {
  streamIdleReconnectPolicy: { maxAttempts: Infinity },
  streamOpenReconnectPolicy: { maxAttempts: Infinity },
} as const satisfies StreamReconnectPolicy;

/**
 * The renderer's subagent surface. One cohesive capability: a renderer that
 * implements it renders whole sections — header, nested steps and tools,
 * ghost sweeps, completion — and a renderer without it simply has no
 * subagent view. Individually-optional methods would let a renderer
 * implement a type-legal subset that ghosts placeholders or duplicates
 * parent tool rows.
 */
export interface SubagentView {
  /** Opens a call's section the moment its dispatch is announced. */
  begin(update: { callId: string; name: string }): void;
  upsertStep(update: SubagentStepUpdate): void;
  upsertTool(update: SubagentToolUpdate): void;
  /** Drops a child tool row whose call never materialized. */
  removeTool(update: { callId: string; childCallId: string }): void;
  /** Marks a call complete so its section collapses on `└ Done…`. */
  complete(update: { authoritative: boolean; callId: string }): void;
  /** Suppresses the parent-level tool row for a child-owned call id. */
  markChildToolCallId(callId: string): void;
}

type SubagentChildStep = {
  reasoning: string;
  message: string;
  finalized: boolean;
};

type SubagentToolStatus =
  | "preparing"
  | "approval-requested"
  | "executing"
  | "done"
  | "failed"
  | "rejected";

type SubagentToolState = {
  toolName: string;
  input: unknown;
  status: SubagentToolStatus;
  output?: unknown;
  errorText?: string;
};

export type SubagentRun = {
  name: string;
  childSessionId: string;
  /** Parent turn that originated this dispatch; cancellation is scoped to it. */
  parentTurnId: string;
  /** Parent completion is provisional; only a child boundary is authoritative. */
  status: "open" | "provisional" | "authoritative";
  /** The parent session, whose client follows the child stream. */
  parentSessionId: string;
  /** The agent task's session, whose stream this run follows. */
  started: AgentStartedStreamEvent;
  /**
   * One entry per logical "child message" — independent of the child's
   * `stepIndex` field, which the harness can reuse across multiple
   * assistant messages within a turn (e.g. a message before a tool call
   * and another message after the tool result both arrive under
   * `stepIndex: 0`). The key is a monotonic counter so each
   * `message.completed` opens a new box on the next inbound delta.
   */
  steps: Map<number, SubagentChildStep>;
  /**
   * Section currently accepting reasoning/message deltas. `null` means
   * the next delta opens a new section.
   */
  currentSectionKey: number | null;
  /** Monotonic counter for new section keys. */
  nextSectionKey: number;
  tools: Map<string, SubagentToolState>;
};

export type SubagentStepUpdate = {
  callId: string;
  subagentName: string;
  sectionKey: number;
  reasoning: string;
  message: string;
  finalized: boolean;
};

export type SubagentToolUpdate = {
  callId: string;
  subagentName: string;
  childCallId: string;
  toolName: string;
  input: unknown;
  status: SubagentToolStatus;
  output?: unknown;
  errorText?: string;
};

export interface SubagentPumpOptions {
  client?: Client;
  view?: SubagentView;
  formatActionResultError: (event: ActionResultStreamEvent) => string;
  /** Runs TUI-owned handling after a child tool result becomes visible. */
  onToolCompleted?: (subagentName: string, toolName: string, output: unknown) => Promise<void>;
}

/** An agent task: its session is announced once, and every call to the task reaches it. */
interface AgentTask {
  readonly name: string;
  started?: AgentStartedStreamEvent;
}

export class SubagentPump {
  readonly #client: Client | undefined;
  readonly #view: SubagentView | undefined;
  readonly #formatActionResultError: (event: ActionResultStreamEvent) => string;
  readonly #onToolCompleted:
    | ((subagentName: string, toolName: string, output: unknown) => Promise<void>)
    | undefined;
  readonly #runs = new Map<string, SubagentRun>();
  readonly #tasks = new Map<string, AgentTask>();
  /** Every task call seen, by call id: its task and the parent turn that made it. */
  readonly #taskCalls = new Map<string, { readonly taskId: string; readonly turnId: string }>();
  readonly #pumps = new Map<string, AbortController>();
  /** Durable child cursor shared by repeated calls into one conversation subagent. */
  readonly #childStreamIndices = new Map<string, number>();
  /** One stream follower owns a conversation child session through its boundary. */
  readonly #activeChildCalls = new Map<string, string>();
  readonly #queuedChildCalls = new Map<string, string[]>();

  constructor(options: SubagentPumpOptions) {
    this.#client = options.client;
    this.#view = options.view;
    this.#formatActionResultError = options.formatActionResultError;
    this.#onToolCompleted = options.onToolCompleted;
  }

  /** A call started or reached a task. A call to an agent task opens a section at once. */
  taskStarted(event: TaskStartedStreamEvent, parentSessionId: string | undefined): void {
    const { callId, name, taskId, turnId } = event.data;
    this.#taskCalls.set(callId, { taskId, turnId });
    const task = this.#tasks.get(taskId);
    if (task === undefined) {
      this.#tasks.set(taskId, { name });
      return;
    }
    if (task.started !== undefined && parentSessionId !== undefined) {
      this.#begin({ callId, parentSessionId, parentTurnId: turnId, started: task.started });
    }
  }

  /**
   * A run opened a session. A session with the agent a task is named after
   * belongs to that agent tool's task; sessions other tools open have no
   * section.
   */
  agentStarted(started: AgentStartedStreamEvent, parentSessionId: string | undefined): void {
    const call = this.#taskCalls.get(started.data.callId);
    const task = call === undefined ? undefined : this.#tasks.get(call.taskId);
    if (call === undefined || task === undefined || task.name !== started.data.name) return;
    task.started ??= started;
    if (parentSessionId === undefined) return;
    this.#begin({
      callId: started.data.callId,
      parentSessionId,
      parentTurnId: call.turnId,
      started: task.started,
    });
  }

  /**
   * The moment a call is known to reach an agent, its section header
   * replaces the parent-level tool row (or its still-preparing
   * placeholder). Without this the placeholder is swept at the step boundary
   * and nothing shows until the child's first content arrives. A later
   * parent-stream translator may replay the call; re-entry only refreshes
   * the name.
   */
  #begin(input: {
    readonly callId: string;
    readonly parentSessionId: string;
    readonly parentTurnId: string;
    readonly started: AgentStartedStreamEvent;
  }): void {
    const { callId, started } = input;
    const existing = this.#runs.get(callId);
    if (existing === undefined) {
      this.#runs.set(callId, {
        name: started.data.name,
        childSessionId: started.data.sessionId,
        parentSessionId: input.parentSessionId,
        parentTurnId: input.parentTurnId,
        status: "open",
        started,
        steps: new Map(),
        currentSectionKey: null,
        nextSectionKey: 0,
        tools: new Map(),
      });
    } else {
      existing.name = started.data.name;
    }
    this.#view?.markChildToolCallId(callId);
    if (existing !== undefined && existing.status !== "open") return;
    this.#view?.begin({ callId, name: started.data.name });
    if (existing !== undefined) return;
    this.#activateOrQueue(callId);
  }

  /**
   * Parent completion is provisional because the child's final events can be
   * in flight on an independent connection. The pump remains open until the
   * child boundary supplies authoritative completion.
   */
  settle(callId: string): void {
    this.#finalizeRun(callId, false);
  }

  abortAll(): void {
    for (const controller of this.#pumps.values()) {
      controller.abort();
    }
    this.#pumps.clear();
    this.#runs.clear();
    this.#tasks.clear();
    this.#taskCalls.clear();
    this.#childStreamIndices.clear();
    this.#activeChildCalls.clear();
    this.#queuedChildCalls.clear();
  }

  /** Settles and aborts the descendants of the cancelled parent turn. */
  settleCancelledTurn(turnId: string): void {
    for (const [callId, run] of this.#runs) {
      if (run.parentTurnId !== turnId) continue;
      this.#finalizeRun(callId, true);
      this.#pumps.get(callId)?.abort();
      this.#pumps.delete(callId);
    }
  }

  /**
   * Opens a parallel stream over the child session and folds its events into
   * nested subagent blocks.
   *
   * Pumps are fire-and-forget and must never be awaited at a turn boundary:
   * a child session parks instead of ending, so its stream stays open and
   * blocking on it would stall the prompt. Pumps stay open across HITL prompts
   * and resume rendering when the subagent unparks; they end on the child's
   * own boundary or via abort.
   */
  #activateOrQueue(callId: string): void {
    const run = this.#runs.get(callId);
    if (run === undefined || run.status === "authoritative") return;
    const activeCallId = this.#activeChildCalls.get(run.childSessionId);
    if (activeCallId === undefined) {
      this.#activeChildCalls.set(run.childSessionId, callId);
      this.#startPump(callId);
      return;
    }
    if (activeCallId === callId) return;
    const queued = this.#queuedChildCalls.get(run.childSessionId) ?? [];
    if (!queued.includes(callId)) queued.push(callId);
    this.#queuedChildCalls.set(run.childSessionId, queued);
  }

  #startPump(callId: string) {
    if (this.#pumps.has(callId)) return;
    const client = this.#client;
    if (!client) return;
    const run = this.#runs.get(callId);
    if (run === undefined || run.status === "authoritative") return;

    const controller = new AbortController();
    this.#pumps.set(callId, controller);

    void (async () => {
      const { childSessionId } = run;
      let cursor = this.#childStreamIndices.get(childSessionId) ?? 0;
      try {
        const events = client.sessions.attach(run.parentSessionId).streamSubagent(run.started, {
          signal: controller.signal,
          startIndex: cursor,
          streamReconnectPolicy: childStreamReconnectPolicy,
        });
        for await (const event of events) {
          if (controller.signal.aborted) return;
          this.#childStreamIndices.set(childSessionId, (cursor += 1));
          const childEventWork = this.#applyChildEvent(callId, event);
          if (childEventWork !== undefined) await childEventWork;
          if (!isCurrentTurnBoundaryEvent(event)) continue;
          // A proxied child approval parks at an intermediate
          // `session.waiting`. Keep following so the approved tool result
          // can still update the nested view.
          if (event.type === "session.waiting" && hasPendingChildApproval(run)) continue;
          this.#finalizeRun(callId, true);
          return;
        }
      } catch {
        // Only a non-retryable failure ends the follower early; the call's
        // `task.settled` still settles the section.
      } finally {
        controller.abort();
        if (this.#pumps.get(callId) === controller) this.#pumps.delete(callId);
      }
    })();
  }

  #registerChildTool(
    callId: string,
    run: SubagentRun,
    request: {
      childCallId: string;
      toolName: string;
      input: unknown;
      status: SubagentToolState["status"];
    },
  ): void {
    const existing = run.tools.get(request.childCallId);
    const tool: SubagentToolState = existing ?? {
      toolName: request.toolName,
      input: request.input,
      status: request.status,
    };
    if (existing) {
      const terminal =
        existing.status === "done" ||
        existing.status === "failed" ||
        existing.status === "rejected";
      if (request.status === "approval-requested" && !terminal) {
        // Some providers announce the action before eve parks it for
        // approval. The later input request is the live state, not a demotion.
        existing.status = request.status;
      } else {
        const priority: Record<SubagentToolState["status"], number> = {
          preparing: 0,
          "approval-requested": 1,
          executing: 2,
          done: 3,
          failed: 3,
          rejected: 3,
        };
        if (priority[request.status] > priority[existing.status]) {
          existing.status = request.status;
        }
      }
      // A late `preparing` announcement must not wipe input the full call
      // already delivered.
      if (request.input !== undefined) {
        existing.input = request.input;
      }
    } else {
      run.tools.set(request.childCallId, tool);
    }
    this.#view?.markChildToolCallId(request.childCallId);
    this.#view?.upsertTool({
      callId,
      subagentName: run.name,
      childCallId: request.childCallId,
      toolName: tool.toolName,
      input: tool.input,
      status: tool.status,
    });
  }

  /**
   * Settles a subagent section: re-emits a finalized snapshot for any
   * still-streaming step (flipping its right-title off `streaming`), sweeps
   * preparing ghosts, and marks the section Done. The run's status field is
   * the idempotency authority — the child's turn boundary and the call's
   * `task.settled` can both land here.
   */
  #finalizeRun(callId: string, authoritative: boolean): void {
    const run = this.#runs.get(callId);
    if (!run || run.status === "authoritative") return;
    if (!authoritative && run.status === "provisional") return;
    run.status = authoritative ? "authoritative" : "provisional";
    for (const [sectionKey, step] of run.steps) {
      if (!step.finalized) {
        step.finalized = true;
        this.#view?.upsertStep({
          callId,
          subagentName: run.name,
          sectionKey,
          reasoning: step.reasoning,
          message: step.message,
          finalized: true,
        });
      }
    }
    run.currentSectionKey = null;
    this.#sweepPreparingTools(callId, run);
    this.#view?.complete({ authoritative, callId });
    if (authoritative) this.#releaseChildSession(callId, run.childSessionId);
  }

  #releaseChildSession(callId: string, childSessionId: string): void {
    const queued = this.#queuedChildCalls.get(childSessionId) ?? [];
    const remaining = queued.filter((queuedCallId) => queuedCallId !== callId);
    if (this.#activeChildCalls.get(childSessionId) !== callId) {
      if (remaining.length === 0) this.#queuedChildCalls.delete(childSessionId);
      else this.#queuedChildCalls.set(childSessionId, remaining);
      return;
    }

    this.#activeChildCalls.delete(childSessionId);
    while (remaining.length > 0) {
      const nextCallId = remaining.shift()!;
      const nextRun = this.#runs.get(nextCallId);
      if (nextRun === undefined || nextRun.status === "authoritative") continue;
      if (remaining.length === 0) this.#queuedChildCalls.delete(childSessionId);
      else this.#queuedChildCalls.set(childSessionId, remaining);
      this.#activeChildCalls.set(childSessionId, nextCallId);
      this.#startPump(nextCallId);
      return;
    }
    this.#queuedChildCalls.delete(childSessionId);
  }

  /**
   * Drops child tool placeholders that never left `preparing` — their input
   * never parsed (the child model emitted bad JSON, or the stream ended
   * mid-generation), so no upgrade is coming and the row would linger as a
   * `Search …` ghost inside the section.
   */
  #sweepPreparingTools(callId: string, run: SubagentRun): void {
    for (const [childCallId, tool] of run.tools) {
      if (tool.status !== "preparing") continue;
      run.tools.delete(childCallId);
      this.#view?.removeTool({ callId, childCallId });
    }
  }

  #applyChildEvent(callId: string, event: MessageStreamEvent): Promise<void> | undefined {
    const run = this.#runs.get(callId);
    if (!run) return;
    // Parent completion is provisional. Any delayed child event reopens the
    // mutable cohort until the child stream supplies its own boundary.
    if (run.status === "provisional") {
      run.status = "open";
      this.#view?.begin({ callId, name: run.name });
    }
    const view = this.#view;

    const emit = (key: number, step: SubagentChildStep) => {
      view?.upsertStep({
        callId,
        subagentName: run.name,
        sectionKey: key,
        reasoning: step.reasoning,
        message: step.message,
        finalized: step.finalized,
      });
    };

    const finalizeCurrent = () => {
      if (run.currentSectionKey === null) return;
      const step = run.steps.get(run.currentSectionKey);
      if (step) {
        step.finalized = true;
        emit(run.currentSectionKey, step);
      }
      run.currentSectionKey = null;
    };

    switch (event.type) {
      case "reasoning.appended": {
        const { key, step } = openCurrentSubagentSection(run);
        step.reasoning = step.reasoning + event.data.reasoningDelta;
        emit(key, step);
        break;
      }
      case "reasoning.completed":
        // Reasoning closes within a section but does not close the section
        // itself — a following `message.appended` should land in the same
        // box. The section closes on `message.completed` or
        // `step.completed`.
        break;
      case "message.appended": {
        const { key, step } = openCurrentSubagentSection(run);
        step.message = step.message + event.data.messageDelta;
        emit(key, step);
        break;
      }
      case "message.completed": {
        const { key, step } = openCurrentSubagentSection(run);
        if (step.message.length === 0) {
          // Some channels emit only `message.completed` without per-delta
          // `message.appended` events. Capture the full text in that case.
          step.message = event.data.message;
        }
        step.finalized = true;
        emit(key, step);
        run.currentSectionKey = null;
        break;
      }
      case "step.completed":
        finalizeCurrent();
        // A valid child call upgrades from `preparing` within its own step;
        // one still preparing at the boundary never parsed and would linger
        // as a placeholder ghost in the section.
        this.#sweepPreparingTools(callId, run);
        break;
      case "actions.requested": {
        // Close any pending text section before the tool call so the
        // tool box renders below it — and the next post-tool message
        // opens a fresh section.
        finalizeCurrent();
        for (const action of event.data.actions) {
          if (action.kind !== "tool-call") continue;
          this.#registerChildTool(callId, run, {
            childCallId: action.callId,
            toolName: action.toolName,
            input: action.input,
            status: "executing",
          });
        }
        break;
      }
      case "input.requested": {
        // Tools that need approval skip `actions.requested` and arrive
        // here as `input.requested` with the action embedded. Register
        // the tool section the same way (status: "approval-requested")
        // so the parent's stale tool box can be suppressed and the
        // child tool appears under the subagent flow.
        finalizeCurrent();
        for (const request of event.data.requests) {
          if (request.action.kind !== "tool-call") continue;
          this.#registerChildTool(callId, run, {
            childCallId: request.action.callId,
            toolName: request.action.toolName,
            input: request.action.input,
            status: "approval-requested",
          });
        }
        break;
      }
      case "action.result": {
        const result = event.data.result;
        if (result.kind !== "tool-result") break;
        const tool = run.tools.get(result.callId);
        if (!tool) break;
        switch (event.data.status) {
          case "completed":
            tool.status = "done";
            tool.output = result.output;
            break;
          case "failed":
            tool.status = "failed";
            tool.errorText = this.#formatActionResultError(event);
            break;
          case "rejected":
            tool.status = "rejected";
            tool.errorText = this.#formatActionResultError(event);
            break;
        }
        const update: SubagentToolUpdate = {
          callId,
          subagentName: run.name,
          childCallId: result.callId,
          toolName: tool.toolName,
          input: tool.input,
          status: tool.status,
        };
        if (tool.output !== undefined) update.output = tool.output;
        if (tool.errorText !== undefined) update.errorText = tool.errorText;
        view?.upsertTool(update);
        if (event.data.status === "completed") {
          return this.#onToolCompleted?.(run.name, tool.toolName, result.output);
        }
        break;
      }
      default:
        // Other events (session.*, turn.*, step.started, etc.) carry no
        // visible text — ignore.
        break;
    }
  }
}

function hasPendingChildApproval(run: SubagentRun): boolean {
  return [...run.tools.values()].some((tool) => tool.status === "approval-requested");
}

function openCurrentSubagentSection(run: SubagentRun): {
  key: number;
  step: SubagentChildStep;
} {
  if (run.currentSectionKey === null) {
    run.currentSectionKey = run.nextSectionKey++;
    run.steps.set(run.currentSectionKey, { reasoning: "", message: "", finalized: false });
  }
  const step = run.steps.get(run.currentSectionKey);
  if (!step) {
    throw new Error("invariant: subagent section state missing for current key");
  }
  return { key: run.currentSectionKey, step };
}
