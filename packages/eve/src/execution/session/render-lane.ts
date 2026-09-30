import { sleep } from "#compiled/@workflow/core/index.js";

import { CHANNEL_CONTEXT_KEY_NAME } from "#context/key-names.js";
import { renderChannelLaneStep } from "#execution/render-lane-step.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";

/** Where a handoff checkpoint carries the lane's state to the successor. */
const RENDER_LANE_CHECKPOINT_KEY = "eve.renderLane";

/** A render step that fails outright tries again after this long. */
const RETRY_AFTER_FAILURE_MS = 5_000;

/**
 * The session channel's render lane, run beside the session loop in the same
 * workflow. It renders after steps that change the channel's render revision,
 * and again when a render asks to wake, one render at a time and never on the
 * session loop's path. Renders read the cursor's committed context and never
 * advance it. Channels without a lane report no revision and cost nothing.
 */
export class SessionRenderLane {
  readonly #cursor: SessionStateCursor;
  #lane: unknown;
  #renderedRevision: string | undefined;
  #wakeAt: number | undefined;
  /** The durable sleep for `#wakeAt`, reused so each state change doesn't start another. */
  #timer: { readonly at: number; readonly elapsed: Promise<void> } | undefined;
  #rendering: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  #held = false;
  #stopped = false;
  #loop: Promise<void> | undefined;

  constructor(input: { readonly cursor: SessionStateCursor; readonly lane?: unknown }) {
    this.#cursor = input.cursor;
    this.#lane = input.lane;
    input.cursor.onAdvance(() => this.#notify());
  }

  start(): void {
    this.#loop ??= this.#run();
  }

  /**
   * Stops starting renders, waits for the one in flight, then renders once more
   * if channel state moved since. Afterwards the lane's state is final until
   * {@link release}; a handoff checkpoint and session finalization need that.
   */
  async settle(): Promise<void> {
    this.#held = true;
    this.#notify();
    await this.#rendering;
    if (this.#revisionMoved()) await this.#render();
  }

  /** Resumes rendering after {@link settle}. */
  release(): void {
    this.#held = false;
    this.#notify();
  }

  /** Ends the lane without rendering again. */
  async stop(): Promise<void> {
    this.#held = true;
    this.#stopped = true;
    this.#notify();
    await this.#loop;
  }

  /** `serializedContext` with the lane's state, for a handoff checkpoint. */
  checkpoint(serializedContext: Record<string, unknown>): Record<string, unknown> {
    return this.#lane === undefined
      ? serializedContext
      : { ...serializedContext, [RENDER_LANE_CHECKPOINT_KEY]: this.#lane };
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      if (!this.#held && (this.#revisionMoved() || this.#wakeDue())) {
        await this.#render();
        continue;
      }
      await this.#nextChange();
    }
    await this.#rendering;
  }

  #revisionMoved(): boolean {
    const revision = renderRevision(this.#cursor.serializedContext);
    return revision !== undefined && revision !== this.#renderedRevision;
  }

  #wakeDue(): boolean {
    return this.#wakeAt !== undefined && Date.now() >= this.#wakeAt;
  }

  async #nextChange(): Promise<void> {
    const changed = new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
    if (this.#held || this.#wakeAt === undefined) {
      await changed;
      return;
    }
    await Promise.race([changed, this.#timerFor(this.#wakeAt)]);
  }

  /**
   * A sleep that loses its race stays recorded and fires later, waking the
   * workflow once with nothing due; reusing it per wake time keeps that to at
   * most one per render, rather than one per state change.
   */
  #timerFor(at: number): Promise<void> {
    if (this.#timer?.at !== at) {
      this.#timer = { at, elapsed: sleep(Math.max(0, at - Date.now())) };
    }
    return this.#timer.elapsed;
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  async #render(): Promise<void> {
    const serializedContext = this.#cursor.serializedContext;
    const revision = renderRevision(serializedContext);
    const rendering = (async () => {
      try {
        const result = await renderChannelLaneStep({ lane: this.#lane, serializedContext });
        this.#lane = result.lane;
        this.#wakeAt = result.wakeInMs === undefined ? undefined : Date.now() + result.wakeInMs;
      } catch {
        this.#wakeAt = Date.now() + RETRY_AFTER_FAILURE_MS;
      }
      this.#renderedRevision = revision;
    })();
    this.#rendering = rendering;
    try {
      await rendering;
    } finally {
      if (this.#rendering === rendering) this.#rendering = undefined;
    }
  }
}

/** Splits a handoff checkpoint's context into the session's context and the lane's state. */
export function takeRenderLaneCheckpoint(serializedContext: Record<string, unknown>): {
  readonly lane: unknown;
  readonly serializedContext: Record<string, unknown>;
} {
  const { [RENDER_LANE_CHECKPOINT_KEY]: lane, ...rest } = serializedContext;
  return { lane, serializedContext: rest };
}

function renderRevision(serializedContext: Record<string, unknown>): string | undefined {
  const channel = serializedContext[CHANNEL_CONTEXT_KEY_NAME];
  if (typeof channel !== "object" || channel === null) return undefined;
  const revision = (channel as { readonly renderRevision?: unknown }).renderRevision;
  return typeof revision === "string" ? revision : undefined;
}
