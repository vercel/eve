/** The output stream that emitted one subprocess line. */
export type ProcessOutputStream = "stdout" | "stderr";

/** A complete line emitted by a child process for parent-owned rendering. */
export interface ProcessOutputLine {
  stream: ProcessOutputStream;
  text: string;
}

/** Receives complete output lines while a parent-owned CLI flow is running a child process. */
export type ProcessOutputHandler = (line: ProcessOutputLine) => void;

/** Accumulates partial chunks until they can be emitted as prompt-safe lines. */
export interface ProcessOutputBuffer {
  write(stream: ProcessOutputStream, chunk: Buffer): void;
  flush(): void;
}

/**
 * Converts raw stdout and stderr chunks into complete lines while preserving blank lines.
 * Carriage returns emitted by progress renderers become new parent-rendered lines.
 */
export function createProcessOutputBuffer(onOutput: ProcessOutputHandler): ProcessOutputBuffer {
  const remainder: Record<ProcessOutputStream, string> = {
    stdout: "",
    stderr: "",
  };

  return {
    write(stream, chunk) {
      const lines = `${remainder[stream]}${chunk.toString("utf8")}`.split(/\r\n|\r|\n/);
      remainder[stream] = lines.pop() ?? "";
      for (const text of lines) {
        onOutput({ stream, text });
      }
    },
    flush() {
      for (const stream of ["stdout", "stderr"] satisfies ProcessOutputStream[]) {
        const text = remainder[stream];
        if (text !== "") {
          onOutput({ stream, text });
          remainder[stream] = "";
        }
      }
    },
  };
}
