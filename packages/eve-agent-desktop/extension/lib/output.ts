import type { SandboxCommandResult, SandboxProcess } from "./process.js";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

interface OutputBudget {
  remaining: number;
}

/** Collect both streams under one byte budget; closing never waits on a sandbox-controlled cancel acknowledgement. */
export function collectCommandOutput(process: SandboxProcess): {
  result: Promise<SandboxCommandResult>;
  close(): void;
} {
  const stdout = process.stdout.getReader();
  const stderr = process.stderr.getReader();
  const budget: OutputBudget = { remaining: MAX_OUTPUT_BYTES };
  const result = Promise.all([
    readText(stdout, budget),
    readText(stderr, budget),
    process.wait(),
  ]).then(([out, err, exited]) => ({ stdout: out, stderr: err, exitCode: exited.exitCode }));
  let closed = false;
  return {
    result,
    close() {
      if (closed) return;
      closed = true;
      for (const reader of [stdout, stderr]) {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
  };
}

async function readText(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  budget: OutputBudget,
): Promise<string> {
  let buffer: Uint8Array = new Uint8Array(0);
  let used = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return new TextDecoder().decode(buffer.subarray(0, used));
    if (value.byteLength > budget.remaining) {
      throw new Error("The desktop command exceeded its 8 MiB combined stdout/stderr limit.");
    }
    budget.remaining -= value.byteLength;
    const needed = used + value.byteLength;
    if (needed > buffer.byteLength) {
      const capacity = Math.min(MAX_OUTPUT_BYTES, Math.max(4096, needed, buffer.byteLength * 2));
      const grown = new Uint8Array(capacity);
      grown.set(buffer.subarray(0, used));
      buffer = grown;
    }
    buffer.set(value, used);
    used = needed;
  }
}
