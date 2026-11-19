const ESC = "\x1b";
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const MOUSE_ON = `${ESC}[?1002h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1002l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_TO_END = `${ESC}[0J`;
const CURSOR_HOME = `${ESC}[H`;
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;

interface AltScreenOutput {
  write(chunk: string): boolean;
}

interface AltScreenEnterOptions {
  cursor?: "hidden" | "visible";
  mouse?: boolean;
}

export class AltScreen {
  readonly #write: (chunk: string) => boolean;
  #active = false;
  #mouse = false;

  constructor(output: AltScreenOutput) {
    this.#write = output.write.bind(output);
  }

  get active(): boolean {
    return this.#active;
  }

  enter(options: AltScreenEnterOptions = {}): void {
    if (this.#active) return;
    const mouse = options.mouse ?? true;
    const cursor = options.cursor ?? "hidden";
    this.#write(
      `${ALT_SCREEN_ON}${cursor === "hidden" ? HIDE_CURSOR : SHOW_CURSOR}${mouse ? MOUSE_ON : ""}`,
    );
    this.#mouse = mouse;
    this.#active = true;
  }

  paint(rows: readonly string[], height: number): void {
    if (!this.#active) return;
    const visible = rows.slice(0, Math.max(0, height));
    const body = visible.map((row, index) => `${ESC}[${index + 1}H${row}`).join("");
    this.#write(`${SYNC_START}${CURSOR_HOME}${CLEAR_TO_END}${body}${SYNC_END}`);
  }

  writeRaw(chunk: string): void {
    if (!this.#active) return;
    this.#write(chunk);
  }

  exit(): void {
    if (!this.#active) return;
    this.#write(`${this.#mouse ? MOUSE_OFF : ""}${SHOW_CURSOR}${ALT_SCREEN_OFF}`);
    this.#mouse = false;
    this.#active = false;
  }
}
