const ESC = "\x1b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_TO_END = `${ESC}[0J`;
const CLEAR_SCREEN = `${ESC}[2J`;
const CLEAR_SCROLLBACK = `${ESC}[3J`;
const CURSOR_HOME = `${ESC}[H`;
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;
const BRACKETED_PASTE_ON = `${ESC}[?2004h`;
const BRACKETED_PASTE_OFF = `${ESC}[?2004l`;

interface LiveRegionOutput {
  write(chunk: string): boolean;
}

interface LiveRegionOptions {
  synchronized?: boolean;
}

export class LiveRegion {
  readonly #write: (chunk: string) => boolean;
  readonly #synchronized: boolean;
  #liveRowCount = 0;

  constructor(output: LiveRegionOutput, options?: LiveRegionOptions) {
    this.#write = output.write.bind(output);
    this.#synchronized = options?.synchronized ?? true;
  }

  hideCursor(): void {
    this.#write(HIDE_CURSOR);
  }

  showCursor(): void {
    this.#write(SHOW_CURSOR);
  }

  emitBracketedPaste(enabled: boolean): void {
    this.#write(enabled ? BRACKETED_PASTE_ON : BRACKETED_PASTE_OFF);
  }

  newline(): void {
    this.#write("\n");
  }

  update(liveRows: readonly string[]): void {
    this.#paint([], liveRows);
  }

  flush(committedRows: readonly string[], liveRows: readonly string[]): void {
    this.#paint(committedRows, liveRows);
  }

  clear(): void {
    if (this.#liveRowCount === 0) {
      this.#write("\r");
      this.#write(CLEAR_TO_END);
      return;
    }
    this.#write(`${this.#moveToTop()}${CLEAR_TO_END}`);
    this.#liveRowCount = 0;
  }

  release(): void {
    this.#write(this.#moveToTop());
    this.#liveRowCount = 0;
  }

  clearAll(): void {
    this.#write(`${CLEAR_SCROLLBACK}${CLEAR_SCREEN}${CURSOR_HOME}`);
    this.#liveRowCount = 0;
  }

  reset(): void {
    this.#liveRowCount = 0;
  }

  #paint(committedRows: readonly string[], liveRows: readonly string[]): void {
    const body =
      this.#moveToTop() +
      CLEAR_TO_END +
      committedRows.map((row) => `${row}\n`).join("") +
      liveRows.join("\n");

    this.#write(this.#synchronized ? `${SYNC_START}${body}${SYNC_END}` : body);
    this.#liveRowCount = liveRows.length;
  }

  #moveToTop(): string {
    if (this.#liveRowCount <= 1) {
      return "\r";
    }
    return `${ESC}[${this.#liveRowCount - 1}F`;
  }
}
