export type ProcessOutputStream = "stdout" | "stderr";

export interface ProcessOutputLine {
  stream: ProcessOutputStream;
  text: string;
}

export type ProcessOutputHandler = (line: ProcessOutputLine) => void;

interface ProcessOutputBuffer {
  write(stream: ProcessOutputStream, chunk: Buffer): void;
  flush(): void;
}

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

export function vercelErrorDetail(stderr: string | undefined): string | undefined {
  return stderr
    ?.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("Vercel CLI "))
    .at(-1);
}
