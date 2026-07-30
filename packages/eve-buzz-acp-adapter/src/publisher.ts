import { spawn } from "node:child_process";
import type { BuzzRoute } from "./types.js";

const OUTPUT_LIMIT = 64 * 1024;

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
  signal?: AbortSignal;
}): Promise<void> {
  if (options.signal?.aborted) throw new Error("Buzz reply publication cancelled");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.buzzCli, publicationArguments(options.route), {
      env: options.environment,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const abort = () => {
      child.kill("SIGKILL");
      finish(new Error("Buzz reply publication cancelled"));
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`buzz CLI timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT)
        stderr += chunk.toString().slice(0, OUTPUT_LIMIT - stderr.length);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `buzz CLI exited with ${signal ?? code}`));
    });
    child.stdin.on("error", (error) => finish(error));
    child.stdin.end(options.text);
  });
}
