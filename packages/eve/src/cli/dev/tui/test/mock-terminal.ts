import { EventEmitter } from "node:events";
import type { TerminalInput, TerminalOutput } from "../terminal-renderer.js";

const ansiControlSequencePattern = new RegExp(
  `^${String.fromCharCode(27)}\\[([0-9?;]*)([ -/]*)([@-~])`,
);

export class MockUserInput extends EventEmitter implements TerminalInput {
  isTTY = true;
  rawModes: boolean[] = [];
  resumeCalls = 0;
  pauseCalls = 0;

  setRawMode(mode: boolean) {
    this.rawModes.push(mode);
    return this;
  }

  resume() {
    this.resumeCalls += 1;
    return this;
  }

  pause() {
    this.pauseCalls += 1;
    return this;
  }

  type(text: string) {
    this.emit("data", Buffer.from(text));
  }

  /** Emits a raw key sequence (e.g. an escape sequence) as one chunk. */
  send(sequence: string) {
    this.emit("data", Buffer.from(sequence));
  }

  enter() {
    this.send("\r");
  }

  backspace() {
    this.send("\u007f");
  }

  up() {
    this.send("\x1b[A");
  }

  down() {
    this.send("\x1b[B");
  }

  left() {
    this.send("\x1b[D");
  }

  right() {
    this.send("\x1b[C");
  }

  ctrlC() {
    this.send("\u0003");
  }

  ctrlN() {
    this.send("\u000e");
  }

  ctrlP() {
    this.send("\u0010");
  }
}

export class MockScreen extends EventEmitter implements TerminalOutput {
  isTTY = true;
  columns: number;
  rows: number;
  #rawOutput = "";
  #lines: string[] = [];
  /** Parallel to `#lines`: `d` marks a cell drawn dim (SGR 2), a space any other cell. */
  #dimCells: string[] = [];
  #dim = false;
  #cursorLine = 0;
  #cursorColumn = 0;
  #mainScreen?: {
    lines: string[];
    dimCells: string[];
    cursorLine: number;
    cursorColumn: number;
  };
  #waiters: Array<{
    text: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];

  constructor({ columns, rows }: { columns: number; rows: number }) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) {
    const text = String(chunk);
    this.#rawOutput += text;
    this.#apply(text);

    if (typeof encodingOrCallback === "function") {
      encodingOrCallback();
    }
    callback?.();

    this.#resolveWaiters();
    return true;
  }

  resize(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }

  /**
   * The visible grid as text. `hideDim` blanks dim cells, leaving what the
   * screen draws at full weight, such as option labels without descriptions.
   */
  snapshot({ hideDim = false }: { readonly hideDim?: boolean } = {}) {
    if (!hideDim) return this.#lines.join("\n");
    return this.#lines
      .map((line, index) => {
        const dim = this.#dimCells[index] ?? "";
        // Index by UTF-16 unit: a cell's marks repeat for each unit it occupies.
        return line.replace(/./gsu, (cell, column: number) =>
          dim[column] === "d" ? " ".repeat(cell.length) : cell,
        );
      })
      .join("\n");
  }

  rawOutput() {
    return this.#rawOutput;
  }

  /**
   * Resolves once the runner parks at an idle prompt: a column-0 `❯` row
   * with no live turn bar on screen. A streaming turn keeps an identical
   * `❯` prompt anchored (Enter inert), so the glyph alone cannot signal
   * readiness — the bar's absence is the discriminator.
   */
  async waitForIdlePrompt(timeoutMs = 1000) {
    // Match the activity row even while its dot is hidden, without treating
    // the completed coda, a prompt, or ordinary prose as active work.
    const liveTurnBar = /^[•* ] (?:Thinking|Generating|Running) \(\d/mu;
    // Unicode glyphs only: the ASCII prompt mark (`>`) is ambiguous with the
    // ASCII brand mark, and every TUI smoke script pins EVE_TUI_UNICODE=1.
    const idle = () => {
      const snapshot = this.snapshot();
      return /^[❯]/mu.test(snapshot) && !liveTurnBar.test(snapshot);
    };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (idle()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for an idle prompt.\n\nScreen:\n${this.snapshot()}`);
  }

  async waitForText(text: string, timeoutMs = 1000, getDebugOutput = () => this.snapshot()) {
    if (this.snapshot().includes(text)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter = {
        text,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.#waiters = this.#waiters.filter((candidate) => candidate !== waiter);
          reject(
            new Error(`Timed out waiting for screen text: ${text}\n\nScreen:\n${getDebugOutput()}`),
          );
        }, timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  #resolveWaiters() {
    const snapshot = this.snapshot();

    for (const waiter of this.#waiters.slice()) {
      if (!snapshot.includes(waiter.text)) {
        continue;
      }

      clearTimeout(waiter.timeout);
      this.#waiters = this.#waiters.filter((candidate) => candidate !== waiter);
      waiter.resolve();
    }
  }

  #apply(input: string) {
    let index = 0;

    while (index < input.length) {
      if (input[index] === "\x1b") {
        const nextIndex = this.#applyEscape(input, index);

        if (nextIndex > index) {
          index = nextIndex;
          continue;
        }
      }

      const character = input[index];
      index += 1;

      if (character === undefined) {
        continue;
      }

      if (character === "\n") {
        this.#cursorLine += 1;
        this.#cursorColumn = 0;
        continue;
      }

      if (character === "\r") {
        this.#cursorColumn = 0;
        continue;
      }

      this.#writeCharacter(character);
    }
  }

  /**
   * Interprets the subset of ANSI control sequences the inline scrollback
   * renderer emits: absolute/relative cursor movement, carriage-return-style
   * line jumps (CPL/CNL), column moves, and the line / screen erases used to
   * redraw the live region. Private-mode toggles (synchronized updates, cursor
   * visibility) and any other sequences are consumed and ignored so they never
   * corrupt the emulated grid.
   */
  #applyEscape(input: string, startIndex: number) {
    const match = input.slice(startIndex).match(ansiControlSequencePattern);

    if (!match) {
      return startIndex;
    }

    const [sequence, rawParameters = "", , command] = match;
    // Private-mode sequences (e.g. `?2026h`, `?25l`) carry no grid effect.
    const isPrivate = rawParameters.startsWith("?");
    const parameters = rawParameters && !isPrivate ? rawParameters.split(";") : [];
    const first = (fallback: number) =>
      parameters[0] === undefined || parameters[0] === "" ? fallback : Number(parameters[0]);

    if (isPrivate) {
      // The alternate screen swaps the grid: entering starts the modal view
      // from a blank screen, leaving restores the transcript snapshot.
      if (rawParameters === "?1049" && (command === "h" || command === "l")) {
        if (command === "h") {
          this.#mainScreen = {
            lines: this.#lines,
            dimCells: this.#dimCells,
            cursorLine: this.#cursorLine,
            cursorColumn: this.#cursorColumn,
          };
          this.#lines = [];
          this.#dimCells = [];
          this.#cursorLine = 0;
          this.#cursorColumn = 0;
        } else if (this.#mainScreen !== undefined) {
          this.#lines = this.#mainScreen.lines;
          this.#dimCells = this.#mainScreen.dimCells;
          this.#cursorLine = this.#mainScreen.cursorLine;
          this.#cursorColumn = this.#mainScreen.cursorColumn;
          this.#mainScreen = undefined;
        }
      }
      return startIndex + sequence.length;
    }

    switch (command) {
      case "H":
      case "f":
        this.#cursorLine = first(1) - 1;
        this.#cursorColumn = (parameters[1] ? Number(parameters[1]) : 1) - 1;
        break;
      case "A": // cursor up
        this.#cursorLine = Math.max(0, this.#cursorLine - first(1));
        break;
      case "B": // cursor down
        this.#cursorLine += first(1);
        break;
      case "C": // cursor forward
        this.#cursorColumn += first(1);
        break;
      case "D": // cursor back
        this.#cursorColumn = Math.max(0, this.#cursorColumn - first(1));
        break;
      case "E": // cursor next line (column 0)
        this.#cursorLine += first(1);
        this.#cursorColumn = 0;
        break;
      case "F": // cursor previous line (column 0)
        this.#cursorLine = Math.max(0, this.#cursorLine - first(1));
        this.#cursorColumn = 0;
        break;
      case "G": // cursor horizontal absolute
        this.#cursorColumn = first(1) - 1;
        break;
      case "J":
        this.#eraseInDisplay(first(0));
        break;
      case "K":
        this.#eraseInLine(first(0));
        break;
      case "m":
        this.#applySgr(parameters);
        break;
      default:
        break;
    }

    return startIndex + sequence.length;
  }

  /**
   * Tracks only intensity: 2 starts dim; 0 and 22 end it, as in a real terminal
   * where bold (1) leaves faint on. Extended colors (38, 48, 58) carry a
   * `5;n` or `2;r;g;b` payload whose numbers are not SGR codes.
   */
  #applySgr(parameters: readonly string[]) {
    const codes = (parameters.length === 0 ? [""] : parameters).map((parameter) =>
      parameter === "" ? 0 : Number(parameter),
    );
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index];
      if (code === 38 || code === 48 || code === 58) {
        const mode = codes[index + 1];
        index += mode === 5 ? 2 : mode === 2 ? 4 : 1;
      } else if (code === 2) {
        this.#dim = true;
      } else if (code === 0 || code === 22) {
        this.#dim = false;
      }
    }
  }

  #eraseInDisplay(mode: number) {
    if (mode === 2 || mode === 3) {
      this.#lines = [];
      this.#dimCells = [];
      this.#cursorLine = 0;
      this.#cursorColumn = 0;
      return;
    }

    if (mode === 1) {
      // Cursor to start of screen.
      for (let line = 0; line < this.#cursorLine; line += 1) {
        this.#lines[line] = "";
        this.#dimCells[line] = "";
      }
      this.#eraseInLine(1);
      return;
    }

    // mode 0: cursor to end of screen — truncate current line at the cursor
    // and drop every line below it.
    this.#eraseInLine(0);
    this.#lines.length = Math.min(this.#lines.length, this.#cursorLine + 1);
    this.#dimCells.length = Math.min(this.#dimCells.length, this.#cursorLine + 1);
  }

  #eraseInLine(mode: number) {
    for (const grid of [this.#lines, this.#dimCells]) {
      const line = grid[this.#cursorLine] ?? "";
      if (mode === 2) {
        grid[this.#cursorLine] = "";
      } else if (mode === 1) {
        grid[this.#cursorLine] = " ".repeat(this.#cursorColumn) + line.slice(this.#cursorColumn);
      } else {
        // mode 0: clear from cursor to end of line.
        grid[this.#cursorLine] = line.slice(0, this.#cursorColumn);
      }
    }
  }

  #writeCharacter(character: string) {
    const write = (grid: string[], cell: string) => {
      const line = (grid[this.#cursorLine] ?? "").padEnd(this.#cursorColumn, " ");
      grid[this.#cursorLine] =
        line.slice(0, this.#cursorColumn) + cell + line.slice(this.#cursorColumn + cell.length);
    };
    write(this.#lines, character);
    write(this.#dimCells, (this.#dim ? "d" : " ").repeat(character.length));
    this.#cursorColumn += character.length;
  }
}
