/**
 * The pinned message-queue panel: client-side state and pure rendering for
 * messages submitted while a turn is still streaming.
 *
 * Enter queues the draft (up to {@link MESSAGE_QUEUE_LIMIT}); each queued
 * message waits for the turn to end, where the whole queue coalesces into
 * the next turn's message. Esc pops the oldest message to steer the
 * conversation instead of waiting: the renderer requests cooperative turn
 * cancellation and the runner submits the popped message as the next turn.
 * Esc on an empty queue arms cancellation; a second Esc cancels the turn
 * without a replacement message.
 *
 * The renderer owns lifecycle (keys, cancel requests, when the runner drains
 * the queue); this module only holds the queue state machine and paints rows.
 */

import type { Theme } from "./theme.js";
import { TOOL_COLUMN_LEAD } from "./rail.js";
import { clipVisible, stripTerminalControls } from "#cli/ui/terminal-text.js";

/** Most messages the queue holds; Enter on a full queue keeps the draft. */
export const MESSAGE_QUEUE_LIMIT = 5;

/** What one Esc press did to the queue state. */
export type MessageQueueEscapeOutcome =
  /**
   * A message is (now) staged for steering — the caller should request
   * cooperative turn cancellation. Repeated presses pop further messages
   * into the same staged steer payload and re-request cancellation.
   */
  | "steer"
  /** Queue empty: cancellation armed; the next Esc cancels. */
  | "armed"
  /** Second Esc on an empty queue — the caller should cancel the turn. */
  | "cancel";

/** Read-only projection consumed by {@link renderMessageQueueRows}. */
export interface MessageQueueView {
  readonly messages: readonly string[];
  readonly full: boolean;
  /** A popped message is staged and turn cancellation was requested. */
  readonly steering: boolean;
  /** First Esc on an empty queue landed; the next one cancels. */
  readonly armed: boolean;
  /** Esc Esc on an empty queue landed; cancellation was requested. */
  readonly cancelling: boolean;
}

export class MessageQueue {
  #messages: string[] = [];
  #steerMessage: string | undefined;
  #escArmed = false;
  #cancelRequested = false;

  get size(): number {
    return this.#messages.length;
  }

  get full(): boolean {
    return this.#messages.length >= MESSAGE_QUEUE_LIMIT;
  }

  /** True when nothing is queued, staged, armed, or cancelling. */
  get idle(): boolean {
    return (
      this.#messages.length === 0 &&
      this.#steerMessage === undefined &&
      !this.#escArmed &&
      !this.#cancelRequested
    );
  }

  /** Queues one message; returns false (draft stays put) when full. */
  enqueue(message: string): boolean {
    if (this.full) return false;
    this.#messages.push(message);
    this.#escArmed = false;
    return true;
  }

  /**
   * Applies one Esc press. Pops the oldest queued message into the staged
   * steer payload while any remain; with an empty queue, arms and then
   * requests cancellation.
   */
  handleEscape(): MessageQueueEscapeOutcome {
    const popped = this.#messages.shift();
    if (popped !== undefined) {
      this.#steerMessage = joinMessages(this.#steerMessage, popped);
      return "steer";
    }
    if (this.#steerMessage !== undefined) {
      // Already steering: re-request cancellation (idempotent server-side).
      return "steer";
    }
    if (!this.#escArmed) {
      this.#escArmed = true;
      return "armed";
    }
    this.#cancelRequested = true;
    return "cancel";
  }

  /** Any non-Esc activity backs out of the armed press-again state. */
  disarm(): void {
    this.#escArmed = false;
  }

  /** Clears per-turn Esc state when a new stream starts rendering. */
  beginTurn(): void {
    this.#escArmed = false;
    this.#cancelRequested = false;
  }

  /**
   * The next prompt to submit after a turn boundary: the staged steer
   * message when one exists (remaining queued messages stay queued for the
   * steered turn), otherwise the whole queue coalesced into one message.
   */
  takePrompt(): string | undefined {
    this.#escArmed = false;
    this.#cancelRequested = false;
    const steer = this.#steerMessage;
    if (steer !== undefined) {
      this.#steerMessage = undefined;
      return steer;
    }
    return this.#takeAllMessages();
  }

  /**
   * Everything still held — staged steer payload plus queued messages —
   * coalesced for restoring into the prompt editor when a turn ends without
   * a clean boundary (interrupt, transport failure). Clears the queue.
   */
  restoreDraft(): string | undefined {
    this.#escArmed = false;
    this.#cancelRequested = false;
    const steer = this.#steerMessage;
    this.#steerMessage = undefined;
    return joinOptionalMessages(steer, this.#takeAllMessages());
  }

  reset(): void {
    this.#messages = [];
    this.#steerMessage = undefined;
    this.#escArmed = false;
    this.#cancelRequested = false;
  }

  view(): MessageQueueView {
    return {
      messages: [...this.#messages],
      full: this.full,
      steering: this.#steerMessage !== undefined,
      armed: this.#escArmed,
      cancelling: this.#cancelRequested,
    };
  }

  #takeAllMessages(): string | undefined {
    if (this.#messages.length === 0) return undefined;
    const combined = this.#messages.reduce<string | undefined>(joinOptionalMessages, undefined);
    this.#messages = [];
    return combined;
  }
}

function joinMessages(existing: string | undefined, appended: string): string {
  return existing === undefined ? appended : `${existing}\n\n${appended}`;
}

function joinOptionalMessages(a: string | undefined, b: string | undefined): string | undefined {
  if (b === undefined) return a;
  return joinMessages(a, b);
}

export interface MessageQueuePanelRowsInput {
  readonly view: MessageQueueView;
  readonly width: number;
  readonly theme: Theme;
  /** True while a turn streams — the only state in which Esc steers. */
  readonly working: boolean;
}

/**
 * Paints the pinned queue panel, indented so its marks share the tool
 * column. Queued messages ride a `│` rail under the header (one clipped
 * line each) and the last closes it with `└`. The header carries the Esc
 * affordance — the panel is where steering and cancellation are taught.
 */
export function renderMessageQueueRows(input: MessageQueuePanelRowsInput): string[] {
  const { view, width, theme, working } = input;
  const c = theme.colors;
  const g = theme.glyph;
  const lead = TOOL_COLUMN_LEAD;

  if (view.messages.length === 0 && !view.steering) {
    if (!working) return [];
    if (view.cancelling) {
      return [clipVisible(`${lead}${c.yellow(g.dotActive)} ${c.dim("Cancelling turn…")}`, width)];
    }
    if (view.armed) {
      return [
        clipVisible(
          `${lead}${c.yellow(g.dotActive)} ${c.dim("Press esc again to cancel the turn")}`,
          width,
        ),
      ];
    }
    return [];
  }

  const rows = [
    clipVisible(`${lead}${c.gray(g.arrowUp)} ${headerBody(view, working, theme)}`, width),
  ];
  for (const [index, message] of view.messages.entries()) {
    const rail = index === view.messages.length - 1 ? g.corner : g.rule;
    const body = firstLine(stripTerminalControls(message));
    rows.push(clipVisible(`${lead}${c.dim(rail)} ${c.dim(body)}`, width));
  }
  return rows;
}

function headerBody(view: MessageQueueView, working: boolean, theme: Theme): string {
  const c = theme.colors;
  const dot = ` ${theme.glyph.dot} `;
  const count = `${String(view.messages.length)}/${String(MESSAGE_QUEUE_LIMIT)}`;
  if (view.steering) {
    const remaining = view.messages.length > 0 ? `${dot}${count} still queued` : "";
    return c.dim(`Steering — cancelling the running turn…${remaining}`);
  }
  const fullness = view.full ? `${dot}queue full` : "";
  const hint = working ? `${dot}esc steers with the next message` : "";
  return `${c.bold("Queue")} ${c.dim(`${count}${fullness}${hint}`)}`;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/u, 1)[0] ?? "";
}
