import { StringDecoder } from "node:string_decoder";
import { format } from "node:util";

import { AltScreen } from "#cli/ui/alt-screen.js";
import { LiveRegion } from "#cli/ui/live-region.js";
import type { LogLevel, LogRecord } from "#internal/logging.js";

import { setConsoleRecordSubscriber } from "../console-records.js";
import type { DevDiagnostics } from "../diagnostics.js";
import {
  isIncompleteOsc,
  isIncompletePaste,
  nextKey,
  sanitizePastedText,
  stripPasteStart,
  type TerminalKey,
} from "./stream-format.js";

export type TerminalInput = {
  isTTY?: boolean;
  on(event: "data", listener: (chunk: Buffer) => void): TerminalInput;
  off(event: "data", listener: (chunk: Buffer) => void): TerminalInput;
  resume(): TerminalInput;
  pause(): TerminalInput;
  setRawMode?: (mode: boolean) => TerminalInput;
};

export type TerminalOutput = {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean;
  on(event: "resize", listener: () => void): TerminalOutput;
  off(event: "resize", listener: () => void): TerminalOutput;
};

/** One line or record of output that did not come from the TUI itself. */
export interface CapturedLog {
  readonly source: "stdout" | "stderr" | "eve";
  /** Severity, when the producer declared one; raw stream writes have none. */
  readonly level?: LogLevel;
  readonly text: string;
}

interface TerminalHandlers {
  key(key: TerminalKey): void;
  /** A terminal reply such as the OSC 11 background color; never a keypress. */
  osc(value: string): void;
  resize(): void;
  log(entry: CapturedLog): void;
}

interface TerminalOptions {
  readonly input: TerminalInput;
  readonly output: TerminalOutput;
  /** Whether process output and console calls are captured while the terminal is active. */
  readonly captureForeignOutput: boolean;
  readonly diagnostics?: DevDiagnostics;
}

// How long to wait on a lone `ESC` before treating it as the Escape key, so a
// split arrow sequence (`ESC` then `[A`) has time to reassemble first.
const escFlushMs = 30;
// How long to wait, with no further input, before abandoning a bracketed paste
// or OSC reply whose terminator never arrived. The timer resets on every read.
const incompleteFlushMs = 1_000;

/**
 * Owns the terminal for the TUI: raw mode, bracketed paste, key decoding, the
 * inline live region, the alternate screen, and capture of foreign output so
 * it cannot corrupt the frame. It knows nothing about what is painted.
 */
export class Terminal {
  readonly live: LiveRegion;
  readonly alt: AltScreen;
  readonly #input: TerminalInput;
  readonly #output: TerminalOutput;
  readonly #options: TerminalOptions;
  readonly #handlers: TerminalHandlers;
  #active = false;
  #keyBuffer = "";
  readonly #decoder = new StringDecoder("utf8");
  #flushTimer?: ReturnType<typeof setTimeout>;
  #restoreCapture?: () => void;

  constructor(options: TerminalOptions, handlers: TerminalHandlers) {
    this.#options = options;
    this.#input = options.input;
    this.#output = options.output;
    this.#handlers = handlers;
    // Both bind the output's original `write` before capture monkeypatches it,
    // so the TUI's own paints are never mistaken for foreign output.
    this.live = new LiveRegion(this.#output);
    this.alt = new AltScreen(this.#output);
  }

  get active(): boolean {
    return this.#active;
  }

  width(): number {
    // `||` so a 0-column report (a sizeless PTY) falls back to a sane default.
    return Math.max(20, this.#output.columns || 80);
  }

  height(): number {
    return Math.max(8, this.#output.rows || 24);
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.live.reset();
    this.live.hideCursor();
    this.#installCapture();
    this.#enterRawMode();
    this.#output.on("resize", this.#onResize);
    process.on("exit", this.#onProcessExit);
  }

  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    this.alt.exit();
    this.live.clear();
    this.live.showCursor();
    this.#removeCapture();
    this.live.newline();
    this.#leaveRawMode();
    this.#output.off("resize", this.#onResize);
    process.off("exit", this.#onProcessExit);
  }

  /** Hands the terminal to a child process that inherits stdio, then takes it back. */
  async suspend<T>(task: () => Promise<T>): Promise<T> {
    if (!this.#active) return await task();
    // Bytes after the key that started the child belong to the child, not the
    // next question after it exits.
    this.#resetKeys();
    this.live.clear();
    this.#removeCapture();
    this.alt.enter({ cursor: "visible", mouse: false });
    this.#leaveRawMode();
    try {
      return await task();
    } finally {
      this.alt.exit();
      this.#enterRawMode();
      this.#resetKeys();
      this.live.hideCursor();
      this.#installCapture();
      this.live.reset();
    }
  }

  #enterRawMode(): void {
    this.#input.on("data", this.#feed);
    if (!this.#input.isTTY) return;
    this.#input.setRawMode?.(true);
    this.#input.resume();
    // Bracketed paste wraps pasted text in markers so a multi-line paste
    // inserts intact instead of each newline submitting the prompt.
    this.live.emitBracketedPaste(true);
  }

  #leaveRawMode(): void {
    this.#input.off("data", this.#feed);
    this.#resetKeys();
    if (!this.#input.isTTY) return;
    this.live.emitBracketedPaste(false);
    this.#input.setRawMode?.(false);
    this.#input.pause();
  }

  readonly #onResize = () => this.#handlers.resize();

  /**
   * Last-resort synchronous restore for a forced `process.exit()` that
   * preempts {@link stop}: a shell left in raw mode with a hidden cursor is
   * unusable, and only synchronous writes survive the "exit" event.
   */
  readonly #onProcessExit = () => {
    if (!this.#active) return;
    this.alt.exit();
    if (this.#input.isTTY) {
      this.live.emitBracketedPaste(false);
      this.#input.setRawMode?.(false);
    }
    this.live.showCursor();
  };

  readonly #feed = (chunk: Buffer) => {
    this.#clearFlush();
    this.#keyBuffer += this.#decoder.write(chunk);
    while (this.#keyBuffer.length > 0) {
      const token = nextKey(this.#keyBuffer);
      if (token.incomplete) break;
      this.#keyBuffer = this.#keyBuffer.slice(token.consumed);
      if (token.key === undefined || token.key.type === "ignore") continue;
      if (token.key.type === "osc") this.#handlers.osc(token.key.value);
      else this.#handlers.key(token.key);
    }
    this.#armFlush();
  };

  /**
   * A lone trailing ESC may begin an arrow key, so it is held briefly before
   * surfacing as Escape. A paste or OSC reply whose terminator never arrives
   * would otherwise wedge input forever; once input goes quiet it is
   * recovered (a paste keeps its framing) or dropped.
   */
  #armFlush(): void {
    const stuck = this.#keyBuffer;
    let flush: (() => void) | undefined;
    let delay = incompleteFlushMs;
    if (stuck === "\x1b") {
      delay = escFlushMs;
      flush = () => this.#handlers.key({ type: "escape" });
    } else if (isIncompletePaste(stuck)) {
      flush = () => {
        const value = sanitizePastedText(stripPasteStart(stuck));
        if (value.length > 0) {
          this.#handlers.key({ type: "text", value, framing: "bracketed-paste" });
        }
      };
    } else if (isIncompleteOsc(stuck)) {
      flush = () => {};
    }
    if (flush === undefined) return;
    this.#flushTimer = setTimeout(() => {
      if (this.#keyBuffer !== stuck) return;
      this.#keyBuffer = "";
      flush();
    }, delay);
    this.#flushTimer.unref?.();
  }

  #clearFlush(): void {
    if (this.#flushTimer === undefined) return;
    clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
  }

  #resetKeys(): void {
    this.#clearFlush();
    this.#keyBuffer = "";
  }

  /**
   * Routes every foreign write and console call into {@link TerminalHandlers.log}
   * while the terminal is active. eve's own structured log records come from
   * the diagnostics recorder, which persists them first.
   */
  #installCapture(): void {
    if (this.#restoreCapture !== undefined || !this.#options.captureForeignOutput) return;
    const log = this.#handlers.log;
    const buffers = { stdout: "", stderr: "" };
    const capture = (target: NodeJS.WriteStream, source: "stdout" | "stderr") => {
      const original = target.write.bind(target);
      target.write = ((
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ): boolean => {
        const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding);
        const combined = buffers[source] + text;
        const newline = combined.lastIndexOf("\n");
        buffers[source] = newline === -1 ? combined : combined.slice(newline + 1);
        if (newline !== -1) log({ source, text: combined.slice(0, newline) });
        (typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
        return true;
      }) as typeof target.write;
      return () => {
        target.write = original;
        if (buffers[source].length > 0) original(`${buffers[source]}\n`);
        buffers[source] = "";
      };
    };
    const consoleMethods = ["error", "warn", "log", "info", "debug"] as const;
    const originals = consoleMethods.map((method) => [method, console[method]] as const);
    const consoleLog = (level: LogLevel, text: string) =>
      log({ source: level === "error" || level === "warn" ? "stderr" : "stdout", level, text });
    for (const method of consoleMethods) {
      console[method] = (...args: unknown[]) =>
        consoleLog(method === "log" ? "info" : method, format(...args));
    }
    setConsoleRecordSubscriber((record) => consoleLog(record.level, record.text));
    const restoreStdout = capture(process.stdout, "stdout");
    const restoreStderr = capture(process.stderr, "stderr");
    this.#options.diagnostics?.subscribeLogRecords((record: LogRecord) => {
      const fields = record.fields === undefined ? "" : ` ${JSON.stringify(record.fields)}`;
      log({
        source: "eve",
        level: record.level,
        text: `[eve:${record.namespace}] ${record.message}${fields}`,
      });
    });
    this.#restoreCapture = () => {
      this.#options.diagnostics?.unsubscribeLogRecords();
      setConsoleRecordSubscriber(undefined);
      for (const [method, original] of originals) console[method] = original;
      restoreStdout();
      restoreStderr();
    };
  }

  #removeCapture(): void {
    const restore = this.#restoreCapture;
    this.#restoreCapture = undefined;
    restore?.();
  }
}
