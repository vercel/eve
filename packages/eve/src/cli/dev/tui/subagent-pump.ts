/**
 * The subagent child-stream subsystem: for every `subagent.called` on the
 * parent stream, a parallel pump over the child session folds its events
 * into the renderer's nested subagent view. Extracted from the runner —
 * the subsystem touches nothing but its own run state, the client, and the
 * {@link SubagentView} seam.
 */

import type { Client } from "#client/index.js";
import {
  isCurrentTurnBoundaryEvent,
  type ActionResultStreamEvent,
  type HandleMessageStreamEvent,
  type SubagentCalledStreamEvent,
} from "#protocol/message.js";
import { toErrorMessage } from "#shared/errors.js";

import { isAbortLikeError } from "./errors.js";

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
  complete(update: { callId: string }): void;
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
  /**
   * The run's one lifecycle authority. `settled` means the final assistant
   * message is in (the child's turn boundary, or the parent's
   * `subagent.completed` fallback); a late child event — a HITL-parked
   * turn resuming — explicitly reopens the run rather than mutating a
   * completed section by accident.
   */
  status: "running" | "settled";
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
   * content arrives. Idempotent for SSE-resume re-entries, which only
   * refresh the name.
   */
  begin(called: SubagentCalledStreamEvent): void {
    const callId = called.data.callId;
    const existing = this.#runs.get(callId);
    if (existing === undefined) {
      this.#runs.set(callId, {
        name: called.data.name,
        status: "running",
        steps: new Map(),
        currentSectionKey: null,
        nextSectionKey: 0,
        tools: new Map(),
      });
    } else {
      existing.name = called.data.name;
    }
    this.#view?.markChildToolCallId(callId);
    this.#view?.begin({ callId, name: called.data.name });
    this.#startPump(called);
  }

  /**
   * Parent reports subagent.completed. The child stream pump terminates
   * itself on the child's own turn boundary — the authoritative finish
   * signal, which already finalized the section — so this is a fallback
   * for runs whose boundary never reached us (a dropped child stream, a
   * HITL-parked turn resuming later). We do NOT abort the pump here,
   * because the child's `message.completed` event may still be in flight
   * (the parent and child streams are independent HTTP connections).
   */
  settle(callId: string): void {
    this.#finalizeRun(callId);
  }

  abortAll(): void {
    for (const controller of this.#pumps.values()) {
      controller.abort();
    }
    this.#pumps.clear();
    this.#runs.clear();
  }

  /**
   * Settles every live run and stops its child stream. Called when the
   * parent turn is cancelled (an Esc steer or Esc Esc): the server cancels
   * the pending descendants, so their sections must close now — a child
   * still flushing reasoning would otherwise keep painting stale sections
   * into the next (steered) turn's transcript. Runs stay registered so a
   * late parent `subagent.completed` settles as a no-op.
   */
  settleAll(): void {
    for (const callId of this.#runs.keys()) {
      this.#finalizeRun(callId);
    }
    for (const controller of this.#pumps.values()) {
      controller.abort();
    }
    this.#pumps.clear();
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

    const controller = new AbortController();
    this.#pumps.set(callId, controller);

    void (async () => {
      let boundaryReached = false;
      try {
        const childSession = client.session({
          sessionId: called.data.childSessionId,
          streamIndex: 0,
        });
        const stream = childSession.stream({ signal: controller.signal });
        for await (const event of stream) {
          if (controller.signal.aborted) break;
          this.#applyChildEvent(callId, event);
          if (isCurrentTurnBoundaryEvent(event)) {
            // The child's own turn boundary — its final assistant message
            // is in — is what finishes the section. The parent's
            // `subagent.completed` arrives independently (often later, once
            // the parent's turn resumes) and only acts as a fallback.
            boundaryReached = true;
            break;
          }
        }
      } catch (error) {
        if (!isAbortLikeError(error)) {
          const errorText = toErrorMessage(error);
          const run = this.#runs.get(callId);
          if (run) {
            const { key, step } = openCurrentSubagentSection(run);
            step.message = step.message
              ? `${step.message}\n\nstream error: ${errorText}`
              : `stream error: ${errorText}`;
            step.finalized = true;
            run.currentSectionKey = null;
            this.#view?.upsertStep({
              callId,
              subagentName: run.name,
              sectionKey: key,
              reasoning: step.reasoning,
              message: step.message,
              finalized: true,
            });
          }
        }
      } finally {
        this.#pumps.delete(callId);
      }
      if (boundaryReached) this.#finalizeRun(callId);
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
  #finalizeRun(callId: string): void {
    const run = this.#runs.get(callId);
    if (!run || run.status === "settled") return;
    run.status = "settled";
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
    this.#view?.complete({ callId });
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

  #applyChildEvent(callId: string, event: HandleMessageStreamEvent) {
    const run = this.#runs.get(callId);
    if (!run) return;
    // A child event after settle is a HITL-parked turn resuming: reopen the
    // run explicitly (begin clears the header's Done mark) instead of
    // mutating a completed section by accident.
    if (run.status === "settled") {
      run.status = "running";
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
