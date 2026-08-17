import { StringDecoder } from "node:string_decoder";

const MAX_CAPTURED_STDOUT_BYTES = 64 * 1024;

export type PackageManagerProcessTermination =
  | { kind: "exit"; code: number }
  | { kind: "signal"; signal: string }
  | { kind: "aborted"; reason?: string }
  | { kind: "spawn-error"; code?: string; message: string };

export interface PackageManagerProcessResult {
  command: { executable: string; args: readonly string[]; cwd: string };
  termination: PackageManagerProcessTermination;
  /** Byte-bounded stdout for commands whose caller needs to interpret it. */
  stdout: string;
}

export function resultSucceeded(result: PackageManagerProcessResult): boolean {
  return result.termination.kind === "exit" && result.termination.code === 0;
}

export interface PackageProcessStdoutCollector {
  end(): void;
  result(termination: PackageManagerProcessTermination): PackageManagerProcessResult;
  write(chunk: Buffer): void;
}

export function createPackageProcessStdoutCollector(input: {
  command: PackageManagerProcessResult["command"];
  maxCapturedBytes?: number;
}): PackageProcessStdoutCollector {
  const maxCapturedBytes = input.maxCapturedBytes ?? MAX_CAPTURED_STDOUT_BYTES;
  const decoder = new StringDecoder("utf8");
  let stdout = "";
  let capturedBytes = 0;

  function capture(text: string): void {
    for (const character of text) {
      const characterBytes = Buffer.byteLength(character);
      if (capturedBytes + characterBytes > maxCapturedBytes) return;
      stdout += character;
      capturedBytes += characterBytes;
    }
  }

  return {
    write(chunk) {
      capture(decoder.write(chunk));
    },
    end() {
      capture(decoder.end());
    },
    result(termination) {
      return { command: input.command, termination, stdout };
    },
  };
}
