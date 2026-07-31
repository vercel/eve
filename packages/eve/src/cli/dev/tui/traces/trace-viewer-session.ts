/**
 * Owns one open `/traces` viewer: the store poller, the navigation state, and
 * frame production. The terminal renderer wires it to the alt screen and the
 * keyboard; everything else lives here so `terminal-renderer.ts` stays small
 * and the poll/repaint lifecycle is testable without a TTY.
 */

import type { TerminalKey } from "../stream-format.js";
import type { Theme } from "../theme.js";
import type { TraceStore, TraceStoreEntry } from "./trace-store.js";
import { createTraceStore } from "./trace-store.js";
import { conversationItemLineCount } from "./trace-conversation.js";
import { renderTraceViewer } from "./trace-view.js";
import type { TraceViewerState } from "./trace-viewer-state.js";
import {
  applyLoadedTrace,
  applyTraceList,
  createTraceViewerState,
  reduceTraceViewerKey,
} from "./trace-viewer-state.js";

const POLL_INTERVAL_MS = 1_000;
/** A trace whose last span landed this recently renders its window up to "now". */
const LIVE_WINDOW_MS = 3_000;

export interface TraceViewerOpenOptions {
  readonly appRoot: string;
  /** Current chat session — its trace opens first. */
  readonly sessionId?: string;
  /** Optional trace id (prefix) from `/traces <trace>`. */
  readonly reference?: string;
}

/** The renderer capability the runner's `/traces` dispatch awaits. */
export interface TraceViewerRenderer {
  open(options: TraceViewerOpenOptions): Promise<void>;
}

export interface TraceViewerSessionOptions extends TraceViewerOpenOptions {
  readonly theme: Theme;
  readonly paint: (rows: readonly string[]) => void;
  readonly dimensions: () => { readonly width: number; readonly height: number };
  readonly tracingDisabled?: boolean;
  readonly store?: TraceStore;
}

export class TraceViewerSession {
  readonly #options: TraceViewerSessionOptions;
  readonly #store: TraceStore;
  #state: TraceViewerState = createTraceViewerState();
  /** Pending one-time selection preference resolved from `/traces <prefix>`. */
  #preferTraceId?: string;
  /**
   * Pending one-time preference for the current chat session. Trace ids are
   * provider-generated, so the session's trace is found by reading candidates
   * newest-first and matching `sessionIds` — a windowed session resolves to
   * its most recently active window, and a subagent session to the parent
   * trace it recorded into.
   */
  #preferSessionId?: string;
  #pollTimer?: ReturnType<typeof setInterval>;
  #disposed = false;
  #refreshing = false;
  #refreshAgain = false;
  #metrics: {
    timelineViewportRows: number;
    panelViewportRows: number;
    panelTotalRows: number;
    contentWidth: number;
    conversationLineCounts?: readonly number[];
  } = { timelineViewportRows: 0, panelViewportRows: 0, panelTotalRows: 0, contentWidth: 0 };

  constructor(options: TraceViewerSessionOptions) {
    this.#options = options;
    this.#store = options.store ?? createTraceStore({ appRoot: options.appRoot });
    if (options.sessionId !== undefined) {
      this.#preferSessionId = options.sessionId;
    }
    if (options.reference !== undefined) {
      this.#preferSessionId = undefined;
      this.#state = {
        ...this.#state,
        notice: `No local trace matches "${options.reference}" yet.`,
      };
    }
  }

  start(): void {
    this.repaint();
    void this.#refresh();
    this.#pollTimer = setInterval(() => void this.#refresh(), POLL_INTERVAL_MS);
    this.#pollTimer.unref?.();
  }

  /** Feeds one key through the reducer; returns `"close"` when the viewer should close. */
  handleKey(key: TerminalKey): "close" | undefined {
    if (this.#disposed) return "close";
    // Manual trace switching cancels any pending one-time preference.
    if (key.type === "text" && (key.value === "[" || key.value === "]")) {
      this.#preferTraceId = undefined;
      this.#preferSessionId = undefined;
    }
    const hadTrace = this.#state.trace !== undefined;
    const { state, effect } = reduceTraceViewerKey(this.#state, key, this.#metrics);
    this.#state = state;
    if (effect === "close") return "close";
    this.repaint();
    // A trace switch cleared the timeline — fetch the newly selected trace
    // immediately instead of leaving a Loading frame up for a full poll.
    if (hadTrace && state.trace === undefined) void this.#refresh();
    return undefined;
  }

  repaint(): void {
    if (this.#disposed) return;
    const { width, height } = this.#options.dimensions();
    const frame = renderTraceViewer(this.#state, {
      width,
      height,
      theme: this.#options.theme,
      tracingDisabled: this.#options.tracingDisabled,
      activeWindowEndNs: this.#activeWindowEndNs(),
    });
    this.#metrics = {
      timelineViewportRows: frame.timelineViewportRows,
      panelViewportRows: frame.panelViewportRows,
      panelTotalRows: frame.panelTotalRows,
      contentWidth: frame.contentWidth,
      conversationLineCounts: this.#state.conversationItems.map((item, index) =>
        conversationItemLineCount(
          item,
          frame.contentWidth,
          this.#options.theme,
          this.#state.expandedItems.has(index),
        ),
      ),
    };
    this.#options.paint(frame.rows);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#pollTimer !== undefined) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }
  }

  async #refresh(): Promise<void> {
    if (this.#disposed) return;
    // Coalesce overlapping polls (a slow disk must not queue repaint storms).
    if (this.#refreshing) {
      this.#refreshAgain = true;
      return;
    }
    this.#refreshing = true;
    try {
      do {
        this.#refreshAgain = false;
        await this.#refreshOnce();
      } while (this.#refreshAgain && !this.#disposed);
    } finally {
      this.#refreshing = false;
    }
  }

  async #refreshOnce(): Promise<void> {
    try {
      const entries = await this.#store.list();
      let prefer = this.#preferTraceId;
      const reference = this.#options.reference;
      if (prefer === undefined && reference !== undefined) {
        prefer = entries.find((entry) => entry.traceId.startsWith(reference))?.traceId;
      }
      if (prefer === undefined && this.#preferSessionId !== undefined) {
        prefer = await this.#resolveSessionTrace(entries, this.#preferSessionId);
      }
      if (this.#disposed) return;
      // Stash the resolution: the post-read re-apply must still honor it,
      // and a manual trace switch during the reads clears it via handleKey.
      if (prefer !== undefined) this.#preferTraceId = prefer;
      const state0 = applyTraceList(this.#state, entries, { preferTraceId: prefer });
      const traceId = entries[state0.traceIndex]?.traceId;
      const trace = traceId === undefined ? undefined : await this.#store.read(traceId);
      if (this.#disposed) return;
      // Re-apply against the live state so key presses during the disk
      // reads (navigation, expansion, trace switches) survive the poll.
      // A trace switch during the read leaves trace undefined so the
      // refresh triggered by handleKey fills it in on the next pass.
      let state = applyTraceList(this.#state, entries, { preferTraceId: this.#preferTraceId });
      if (
        this.#preferTraceId !== undefined &&
        entries[state.traceIndex]?.traceId === this.#preferTraceId
      ) {
        this.#preferTraceId = undefined;
        this.#preferSessionId = undefined;
        if (state.notice?.startsWith("No local trace matches")) {
          state = { ...state, notice: undefined };
        }
      }
      if (entries[state.traceIndex]?.traceId === traceId) {
        state = applyLoadedTrace(state, trace);
      }
      this.#state = state;
      this.repaint();
    } catch {
      // Spool reads race the writer and retention; keep showing the last good frame.
    }
  }

  /**
   * Finds the trace holding the session by reading candidates newest-first.
   * Store reads cache parsed segments, so repeat polls only touch new files.
   */
  async #resolveSessionTrace(
    entries: readonly TraceStoreEntry[],
    sessionId: string,
  ): Promise<string | undefined> {
    for (const entry of entries) {
      const trace = await this.#store.read(entry.traceId);
      if (this.#disposed) return undefined;
      if (trace?.sessionIds.includes(sessionId)) return entry.traceId;
    }
    return undefined;
  }

  #activeWindowEndNs(): bigint | undefined {
    const entry = this.#state.traces[this.#state.traceIndex];
    if (entry === undefined || this.#state.trace === undefined) return undefined;
    if (Date.now() - entry.lastActivityMs > LIVE_WINDOW_MS) return undefined;
    return BigInt(Date.now()) * 1_000_000n;
  }
}
