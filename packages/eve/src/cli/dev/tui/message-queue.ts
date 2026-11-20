import type { Theme } from "./theme.js";
import { TOOL_COLUMN_LEAD } from "./rail.js";
import { clipVisible, stripTerminalControls } from "#cli/ui/terminal-text.js";

export const MESSAGE_QUEUE_LIMIT = 5;

export interface MessageQueueView {
  readonly messages: readonly string[];
  readonly full: boolean;
}

export class MessageQueue {
  #messages: string[] = [];

  get full(): boolean {
    return this.#messages.length >= MESSAGE_QUEUE_LIMIT;
  }

  enqueue(message: string): boolean {
    if (this.full) return false;
    this.#messages.push(message);
    return true;
  }

  take(): string[] {
    const messages = this.#messages;
    this.#messages = [];
    return messages;
  }

  view(): MessageQueueView {
    return { messages: [...this.#messages], full: this.full };
  }
}

export function coalesceQueuedMessages(messages: readonly string[]): string | undefined {
  return messages.length === 0 ? undefined : messages.join("\n\n");
}

export interface MessageQueuePanelRowsInput {
  readonly view: MessageQueueView;
  readonly width: number;
  readonly theme: Theme;
}

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
