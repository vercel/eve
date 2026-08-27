import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { BuzzRoute } from "./types.js";

const OUTPUT_LIMIT = 64 * 1024;
const EVENT_ID = /^[0-9a-f]{64}$/i;

interface PublicationProcess {
  readonly stderr: Readable;
  readonly stdin: Writable;
  readonly stdout: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

type SpawnPublicationProcess = (
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => PublicationProcess;

export type PublicationOutcome =
  | { kind: "delivered"; eventId: string }
  | { kind: "not-delivered"; reason: string }
  | { kind: "unknown"; reason: string };

export function publicationArguments(route: BuzzRoute): string[] {
  return [
    "messages",
    "send",
    "--channel",
    route.channelId,
    "--content",
    "-",
    ...(route.replyTo ? ["--reply-to", route.replyTo] : []),
  ];
}

export async function publishBuzzReply(options: {
  buzzCli: string;
  environment: NodeJS.ProcessEnv;
  route: BuzzRoute;
  text: string;
  timeoutMs: number;
  /** @internal Test seam. */
  spawnProcess?: SpawnPublicationProcess;
}): Promise<PublicationOutcome> {
  return await new Promise<PublicationOutcome>((resolve) => {
    const spawnProcess: SpawnPublicationProcess =
      options.spawnProcess ??
      ((command, args, environment) =>
        spawn(command, [...args], { env: environment, stdio: ["pipe", "pipe", "pipe"] }));
    const child = spawnProcess(
      options.buzzCli,
      publicationArguments(options.route),
      options.environment,
    );
    let spawned = false;
    let stdout = "";
    let stderr = "";
    let stdoutOverflow = false;
    let inputError: Error | undefined;
    let settled = false;

    const finish = (outcome: PublicationOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        kind: "unknown",
        reason: `buzz CLI timed out after ${options.timeoutMs}ms; delivery could not be confirmed`,
      });
    }, options.timeoutMs);

    child.once("spawn", () => {
      spawned = true;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = OUTPUT_LIMIT - Buffer.byteLength(stdout);
      if (chunk.byteLength > remaining) stdoutOverflow = true;
      if (remaining > 0) stdout += chunk.subarray(0, remaining).toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = OUTPUT_LIMIT - Buffer.byteLength(stderr);
      if (remaining > 0) stderr += chunk.subarray(0, remaining).toString();
    });
    child.once("error", (error) => {
      finish({
        kind: spawned ? "unknown" : "not-delivered",
        reason: spawned
          ? `${error.message}; delivery could not be confirmed`
          : `Could not start buzz CLI: ${error.message}`,
      });
    });
    child.once("close", (code, signal) => {
      const response = stdoutOverflow ? undefined : parsePublicationResponse(stdout);
      if (response?.accepted === true) {
        finish({ kind: "delivered", eventId: response.eventId });
        return;
      }
      if (response?.accepted === false) {
        finish({ kind: "not-delivered", reason: "buzz rejected the message" });
        return;
      }
      const detail =
        stderr.trim() || inputError?.message || `buzz CLI exited with ${signal ?? code}`;
      finish({
        kind: "unknown",
        reason: `${detail}; delivery could not be confirmed`,
      });
    });
    child.stdin.once("error", (error) => {
      inputError = error;
    });
    child.stdin.end(options.text);
  });
}

export function parsePublicationResponse(
  output: string,
): { accepted: true; eventId: string } | { accepted: false } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const response = value as { accepted?: unknown; event_id?: unknown };
  if (response.accepted === false) return { accepted: false };
  if (response.accepted !== true || typeof response.event_id !== "string") return undefined;
  if (!EVENT_ID.test(response.event_id)) return undefined;
  return { accepted: true, eventId: response.event_id };
}
