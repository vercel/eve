import { StringDecoder } from "node:string_decoder";

import type { ProcessOutputStream } from "../process-output.js";

const MAX_RETAINED_OUTPUT_BYTES = 64 * 1024;

/** Raw package-manager output. It may contain sensitive user or lifecycle-script data. */
export interface ProcessOutputChunk {
  emittedSequence: number;
  stream: ProcessOutputStream;
  text: string;
}

export type PackageManagerProcessTermination =
  | { kind: "exit"; code: number }
  | { kind: "signal"; signal: string }
  | { kind: "aborted"; reason?: string }
  | { kind: "spawn-error"; code?: string; message: string };

export interface PackageManagerProcessResult {
  command: { executable: string; args: readonly string[]; cwd: string };
  termination: PackageManagerProcessTermination;
  /** Byte-bounded, in-memory output. It must not be persisted or included in diagnostics. */
  output: readonly ProcessOutputChunk[];
  truncatedBytes: number;
}

export function resultSucceeded(result: PackageManagerProcessResult): boolean {
  return result.termination.kind === "exit" && result.termination.code === 0;
}

export interface PackageProcessOutputCollector {
  end(): void;
  result(termination: PackageManagerProcessTermination): PackageManagerProcessResult;
  write(stream: ProcessOutputStream, chunk: Buffer): void;
}

export function createPackageProcessOutputCollector(input: {
  command: PackageManagerProcessResult["command"];
  maxRetainedBytes?: number;
  onOutput?: (chunk: ProcessOutputChunk) => void;
}): PackageProcessOutputCollector {
  const maxRetainedBytes = input.maxRetainedBytes ?? MAX_RETAINED_OUTPUT_BYTES;
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  const output: ProcessOutputChunk[] = [];
  let retainedBytes = 0;
  let truncatedBytes = 0;
  let emittedSequence = 0;

  function emit(stream: ProcessOutputStream, text: string): void {
    if (text === "") return;
    const chunk = { emittedSequence: emittedSequence++, stream, text };
    input.onOutput?.(chunk);

    const decodedBytes = Buffer.byteLength(text);
    const remaining = Math.max(0, maxRetainedBytes - retainedBytes);
    if (decodedBytes <= remaining) {
      output.push(chunk);
      retainedBytes += decodedBytes;
      return;
    }

    let retainedText = "";
    let retainedTextBytes = 0;
    for (const character of text) {
      const characterBytes = Buffer.byteLength(character);
      if (retainedTextBytes + characterBytes > remaining) break;
      retainedText += character;
      retainedTextBytes += characterBytes;
    }
    if (retainedText !== "") output.push({ ...chunk, text: retainedText });
    retainedBytes += retainedTextBytes;
    truncatedBytes += decodedBytes - retainedTextBytes;
  }

  return {
    write(stream, chunk) {
      emit(stream, decoders[stream].write(chunk));
    },
    end() {
      for (const stream of ["stdout", "stderr"] satisfies ProcessOutputStream[]) {
        emit(stream, decoders[stream].end());
      }
    },
    result(termination) {
      return { command: input.command, termination, output, truncatedBytes };
    },
  };
}
