/**
 * The subagent child-stream subsystem: for every `subagent.called` on the
 * parent stream, a parallel pump over the child session folds its events
 * into the renderer's nested subagent view. Extracted from the runner —
 * the subsystem touches nothing but its own run state, the client, and the
 * {@link SubagentView} seam.
 */

import type { Client } from "#client/index.js";
import { readNdjsonStream } from "#client/ndjson.js";
import { createEventDeduper, type EventDeduper } from "#protocol/event-dedupe.js";
import {
  isCurrentTurnBoundaryEvent,
  type ActionResultStreamEvent,
  type MessageStreamEvent,
  type SubagentCalledStreamEvent,
} from "#protocol/message.js";
const childStreamReconnectBaseDelayMs = 100;
const childStreamReconnectMaxDelayMs = 2_000;

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
  /** Keeps a receipt-returned background call mutable across parent turns. */
  background(update: { callId: string }): void;
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
  /** Parent turn that originated this dispatch; cancellation is scoped to it. */
  parentTurnId: string;
  /** A receipt-returned task survives cancellation of its originating turn. */
  background: boolean;
  /** Parent completion is provisional; only a child boundary is authoritative. */
  status: "open" | "provisional" | "authoritative";
  /** Parent-authored route on the parent origin, valid for local and remote children. */
  childStreamPath: string;
  /** Absolute durable cursor retained across exhausted transport sources. */
  childStreamIndex: number;
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
  /**
   * Child events already folded into this run. A restarted pump replays the
   * child stream from `streamIndex: 0` while this run's state survives.
   */
  seenChildEvents: EventDeduper;
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
}

export class SubagentPump {
  readonly #client: Client | undefined;
  readonly #view: SubagentView | undefined;
  readonly #formatActionResultError: (event: ActionResultStreamEvent) => string;
  readonly #runs = new Map<string, SubagentRun>();
  readonly #pumps = new Map<string, AbortController>();

  constructor(options: SubagentPumpOptions) {
    this.#client = options.client;
    this.#view = options.view;
    this.#formatActionResultError = options.formatActionResultError;
  }

  /**
   * The moment a dispatch is known to be a subagent call, its section
   * header replaces the parent-level tool row (or its still-preparing
   * placeholder — subagent dispatches never upgrade one, since their
   * actions are not tool-call kind). Without this the placeholder is
   * swept at the step boundary and nothing shows until the child's first
   * content arrives. A later parent-stream translator may replay the call;
   * re-entry only refreshes the name.
   */
  begin(called: SubagentCalledStreamEvent): void {
    const callId = called.data.callId;
    const existing = this.#runs.get(callId);
    if (existing === undefined) {
      this.#runs.set(callId, {
        name: called.data.name,
        parentTurnId: called.data.turnId,
        background: false,
        status: "open",
        childStreamPath: called.data.childStreamPath,
        childStreamIndex: 0,
        steps: new Map(),
        currentSectionKey: null,
        nextSectionKey: 0,
        tools: new Map(),
        seenChildEvents: createEventDeduper(),
      });
    } else {
      existing.name = called.data.name;
    }
    this.#view?.markChildToolCallId(callId);
    if (existing !== undefined && existing.status !== "open") return;
    this.#view?.begin({ callId, name: called.data.name });
    this.#startPump(called);
  }

  /**
   * Parent completion is provisional because the child's final events can be
   * in flight on an independent connection. The pump remains open until the
   * child boundary supplies authoritative completion.
   */
  settle(callId: string): void {
    this.#finalizeRun(callId, false);
  }

  /**
   * The originating call returned a task receipt, not the child's result.
   * Keep the section open until the child stream reaches its own boundary.
   * A child that already settled before the receipt raced in stays settled.
   */
  background(callId: string): void {
    const run = this.#runs.get(callId);
    if (run === undefined) return;
    run.background = true;
    if (run.status === "authoritative") return;
    this.#view?.background({ callId });
  }

  abortAll(): void {
    for (const controller of this.#pumps.values()) {
      controller.abort();
    }
    this.#pumps.clear();
    this.#runs.clear();
  }

  /**
   * Settles and aborts only foreground descendants of the cancelled parent
   * turn. Background tasks survive even when that same turn started them.
   */
  settleCancelledTurn(turnId: string): void {
    for (const [callId, run] of this.#runs) {
      if (run.parentTurnId !== turnId || run.background) continue;
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
   * a subagent dispatched in `task` mode that parks for HITL never emits a
   * turn-boundary event on its own stream (`harness/tool-loop.ts` gates
   * `emitTurnEpilogue` on `mode === "conversation"`), so blocking on a child
   * stream would stall the prompt until the subagent's serverless function
   * times out. Pumps stay open across HITL prompts and resume rendering when
   * the subagent unparks; they end on the child's own boundary or via abort.
   */
  #startPump(called: SubagentCalledStreamEvent) {
    const callId = called.data.callId;
    if (this.#pumps.has(callId)) return;
    const client = this.#client;
    if (!client) return;
    const run = this.#runs.get(callId);
    if (run === undefined || run.status === "authoritative") return;

    const controller = new AbortController();
    this.#pumps.set(callId, controller);

    void (async () => {
      let reconnectDelayMs = childStreamReconnectBaseDelayMs;
      try {
        while (!controller.signal.aborted && run.status !== "authoritative") {
          let deliveredEvent = false;
          try {
            const response = await client.fetch(
              streamPathAt(run.childStreamPath, run.childStreamIndex),
              {
                cache: "no-store",
                signal: controller.signal,
              },
            );
            if (!response.ok || response.body === null) {
              await response.body?.cancel().catch(() => {});
              throw new Error(`Child stream returned ${response.status}.`);
            }

            for await (const event of readNdjsonStream(response.body)) {
              if (controller.signal.aborted) return;
              deliveredEvent = true;
              run.childStreamIndex += 1;
              this.#applyChildEvent(callId, event);
              if (isCurrentTurnBoundaryEvent(event)) {
                this.#finalizeRun(callId, true);
                return;
              }
            }
          } catch {
            if (controller.signal.aborted) return;
          }

          reconnectDelayMs = deliveredEvent
            ? childStreamReconnectBaseDelayMs
            : Math.min(reconnectDelayMs * 2, childStreamReconnectMaxDelayMs);
          await abortableDelay(reconnectDelayMs, controller.signal);
        }
      } finally {
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
      // Promote status only when the new status is "stronger" — e.g.
      // approval-requested → executing once the parent approves, but
      // never demote from done/failed back to executing.
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
   * the idempotency authority — the child's turn boundary and the parent's
   * `subagent.completed` can both land here.
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

  #applyChildEvent(callId: string, event: MessageStreamEvent) {
    const run = this.#runs.get(callId);
    if (!run) return;
    if (!run.seenChildEvents.admit(event)) return;
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
        if (event.data.message !== null && step.message.length === 0) {
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
        break;
      }
      default:
        // Other events (session.*, turn.*, step.started, etc.) carry no
        // visible text — ignore.
        break;
    }
  }
}

function streamPathAt(path: string, startIndex: number): string {
  if (startIndex === 0) return path;
  return `${path}${path.includes("?") ? "&" : "?"}startIndex=${startIndex}`;
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
