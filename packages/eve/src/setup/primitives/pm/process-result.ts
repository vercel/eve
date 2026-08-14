import { StringDecoder } from "node:string_decoder";

import type { ProcessOutputStream } from "../process-output.js";

export const MAX_STREAMING_SECRET_LENGTH = 256;
const MIN_ENV_SECRET_LENGTH = 8;
const MAX_RETAINED_OUTPUT_BYTES = 64 * 1024;
const REDACTED = "[REDACTED]";

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
  output: readonly ProcessOutputChunk[];
  truncatedBytes: number;
}

export function resultSucceeded(result: PackageManagerProcessResult): boolean {
  return result.termination.kind === "exit" && result.termination.code === 0;
}

const CREDENTIAL_ENV_KEY = /(?:TOKEN|PASSWORD|PASSWD|SECRET|AUTH|API_KEY|NPM_TOKEN)$/iu;
const TOKEN_PATTERN =
  /\b(?:npm_[A-Za-z0-9]{16,240}|(?:gh[opusr]|github_pat)_[A-Za-z0-9_]{16,240}|(?:sk|vercel)_[A-Za-z0-9_-]{16,240})\b/gu;
const AUTHORIZATION_PATTERN = /\b(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]{8,256}/giu;
const CREDENTIAL_URL_PATTERN = /\b(https?:\/\/[^\s/@:]+:)[^\s/@]{1,256}@/giu;

function credentialEnvironmentValues(): string[] {
  return Object.entries(process.env).flatMap(([key, value]) => {
    if (
      value === undefined ||
      value.length < MIN_ENV_SECRET_LENGTH ||
      value.length > MAX_STREAMING_SECRET_LENGTH ||
      !CREDENTIAL_ENV_KEY.test(key)
    ) {
      return [];
    }
    return [value];
  });
}

function redact(text: string, environmentValues: readonly string[]): string {
  let redacted = text
    .replace(CREDENTIAL_URL_PATTERN, `$1${REDACTED}@`)
    .replace(AUTHORIZATION_PATTERN, `$1${REDACTED}`)
    .replace(TOKEN_PATTERN, REDACTED);
  for (const value of environmentValues) redacted = redacted.replaceAll(value, REDACTED);
  return redacted;
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
  const environmentValues = credentialEnvironmentValues();
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  const pending = { stdout: "", stderr: "" };
  const output: ProcessOutputChunk[] = [];
  let retainedBytes = 0;
  let truncatedBytes = 0;
  let emittedSequence = 0;

  function emit(stream: ProcessOutputStream, decoded: string): void {
    if (decoded === "") return;
    const text = redact(decoded, environmentValues);
    const chunk = { emittedSequence: emittedSequence++, stream, text };
    input.onOutput?.(chunk);

    const decodedBytes = Buffer.byteLength(decoded);
    const remaining = Math.max(0, maxRetainedBytes - retainedBytes);
    if (decodedBytes <= remaining) {
      output.push(chunk);
      retainedBytes += decodedBytes;
      return;
    }

    let retainedSource = "";
    let retainedSourceBytes = 0;
    for (const character of decoded) {
      const characterBytes = Buffer.byteLength(character);
      if (retainedSourceBytes + characterBytes > remaining) break;
      retainedSource += character;
      retainedSourceBytes += characterBytes;
    }
    if (retainedSource !== "")
      output.push({ ...chunk, text: redact(retainedSource, environmentValues) });
    retainedBytes += retainedSourceBytes;
    truncatedBytes += decodedBytes - retainedSourceBytes;
  }

  function flushEligible(stream: ProcessOutputStream): void {
    const eligibleLength = pending[stream].length - (MAX_STREAMING_SECRET_LENGTH - 1);
    if (eligibleLength <= 0) return;
    emit(stream, pending[stream].slice(0, eligibleLength));
    pending[stream] = pending[stream].slice(eligibleLength);
  }

  return {
    write(stream, chunk) {
      pending[stream] += decoders[stream].write(chunk);
      flushEligible(stream);
    },
    end() {
      for (const stream of ["stdout", "stderr"] satisfies ProcessOutputStream[]) {
        pending[stream] += decoders[stream].end();
        emit(stream, pending[stream]);
        pending[stream] = "";
      }
    },
    result(termination) {
      return { command: input.command, termination, output, truncatedBytes };
    },
  };
}
