/**
 * The pinned message-queue panel: messages submitted while the agent is still
 * starting. Each queued message waits for the agent to become ready, where the
 * whole queue coalesces into the first turn's message.
 */

import type { Theme } from "./theme.js";
import { TOOL_COLUMN_LEAD } from "./rail.js";
import { clipVisible, stripTerminalControls } from "#cli/ui/terminal-text.js";

/** Most messages the queue holds; Enter on a full queue keeps the draft. */
export const MESSAGE_QUEUE_LIMIT = 5;

/** Read-only projection consumed by {@link renderMessageQueueRows}. */
export interface MessageQueueView {
  readonly messages: readonly string[];
  readonly full: boolean;
}

export class MessageQueue {
  #messages: string[] = [];

  get full(): boolean {
    return this.#messages.length >= MESSAGE_QUEUE_LIMIT;
  }

  /** Queues one message; returns false (draft stays put) when full. */
  enqueue(message: string): boolean {
    if (this.full) return false;
    this.#messages.push(message);
    return true;
  }

  /** Every queued message coalesced into one prompt; clears the queue. */
  takePrompt(): string | undefined {
    if (this.#messages.length === 0) return undefined;
    const combined = this.#messages.join("\n\n");
    this.#messages = [];
    return combined;
  }

  view(): MessageQueueView {
    return { messages: [...this.#messages], full: this.full };
  }
}

export interface MessageQueuePanelRowsInput {
  readonly view: MessageQueueView;
  readonly width: number;
  readonly theme: Theme;
}

/**
 * Paints the pinned queue panel, indented so its marks share the tool
 * column. Queued messages ride a `│` rail under the header (one clipped
 * line each) and the last closes it with `└`.
 */
export function renderMessageQueueRows(input: MessageQueuePanelRowsInput): string[] {
  const { view, width, theme } = input;
  if (view.messages.length === 0) return [];
  const c = theme.colors;
  const g = theme.glyph;
  const lead = TOOL_COLUMN_LEAD;
  const count = `${String(view.messages.length)}/${String(MESSAGE_QUEUE_LIMIT)}`;
  const fullness = view.full ? ` ${g.dot} queue full` : "";
  const rows = [
    clipVisible(
      `${lead}${c.gray(g.arrowUp)} ${c.bold("Queue")} ${c.dim(`${count}${fullness}`)}`,
      width,
    ),
  ];
  for (const [index, message] of view.messages.entries()) {
    const rail = index === view.messages.length - 1 ? g.corner : g.rule;
    const body = firstLine(stripTerminalControls(message));
    rows.push(clipVisible(`${lead}${c.dim(rail)} ${c.dim(body)}`, width));
  }
  return rows;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/u, 1)[0] ?? "";
}
