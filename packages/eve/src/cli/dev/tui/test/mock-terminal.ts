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
}

export class MockScreen extends EventEmitter implements TerminalOutput {
  isTTY = true;
  columns: number;
  rows: number;
  #rawOutput = "";
  #lines: string[] = [];
  #cursorLine = 0;
  #cursorColumn = 0;
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

  snapshot() {
    return this.#lines.join("\n");
  }

  rawOutput() {
    return this.#rawOutput;
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
      default:
        break;
    }

    return startIndex + sequence.length;
  }

  #eraseInDisplay(mode: number) {
    if (mode === 2 || mode === 3) {
      this.#lines = [];
      this.#cursorLine = 0;
      this.#cursorColumn = 0;
      return;
    }

    if (mode === 1) {
      // Cursor to start of screen.
      for (let line = 0; line < this.#cursorLine; line += 1) {
        this.#lines[line] = "";
      }
      this.#eraseInLine(1);
      return;
    }

    // mode 0: cursor to end of screen — truncate current line at the cursor
    // and drop every line below it.
    this.#eraseInLine(0);
    this.#lines.length = Math.min(this.#lines.length, this.#cursorLine + 1);
  }

  #eraseInLine(mode: number) {
    const line = this.#lines[this.#cursorLine] ?? "";

    if (mode === 2) {
      this.#lines[this.#cursorLine] = "";
      return;
    }

    if (mode === 1) {
      this.#lines[this.#cursorLine] =
        " ".repeat(this.#cursorColumn) + line.slice(this.#cursorColumn);
      return;
    }

    // mode 0: clear from cursor to end of line.
    this.#lines[this.#cursorLine] = line.slice(0, this.#cursorColumn);
  }

  #writeCharacter(character: string) {
    const line = (this.#lines[this.#cursorLine] ?? "").padEnd(this.#cursorColumn, " ");
    const nextLine =
      line.slice(0, this.#cursorColumn) +
      character +
      line.slice(this.#cursorColumn + character.length);
    this.#lines[this.#cursorLine] = nextLine;
    this.#cursorColumn += character.length;
  }
}
