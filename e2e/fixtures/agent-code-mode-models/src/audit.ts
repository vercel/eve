import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ToolContext } from "eve/tools";

export interface Call {
  callId: string;
  tool: string;
  input: unknown;
  started: number;
  finished?: number;
  status: "running" | "completed" | "failed";
}

function directory(sessionId: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid session id");
  return join(tmpdir(), "eve-code-mode-models", sessionId);
}

// These real-model evals run in the local world. Files let the HTTP handler and
// tool steps observe the same calls even when their modules are bundled separately.
export async function readCalls(sessionId: string): Promise<Call[]> {
  const dir = directory(sessionId);
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const records = names.filter((name) => /^[a-f0-9]{64}$/.test(name));
  if (records.length > 64) throw new Error("Fixture exceeded 64 calls");
  return Promise.all(
    records.map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8"))),
  );
}

export async function clearCalls(sessionId: string) {
  await rm(directory(sessionId), { recursive: true, force: true });
}

export async function record<T>(ctx: ToolContext, input: unknown, execute: () => T | Promise<T>) {
  const dir = directory(ctx.session.id);
  await mkdir(dir, { recursive: true });
  const calls = await readCalls(ctx.session.id);
  if (calls.length >= 64) throw new Error("Fixture exceeded 64 calls");
  const path = join(dir, createHash("sha256").update(ctx.callId).digest("hex"));
  const call: Call = {
    callId: ctx.callId,
    tool: ctx.toolName,
    input,
    started: Date.now(),
    status: "running",
  };
  await saveCall(path, call);
  try {
    const result = await execute();
    call.status = "completed";
    return result;
  } catch (error) {
    call.status = "failed";
    throw error;
  } finally {
    call.finished = Date.now();
    await saveCall(path, call);
  }
}

async function saveCall(path: string, call: Call) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(call));
  await rename(temporary, path);
}

export async function waitForBalances(ctx: ToolContext, accountIds: readonly string[]) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const calls = (await readCalls(ctx.session.id)).filter((call) => call.tool === ctx.toolName);
    if (
      accountIds.every((id) =>
        calls.some((call) => (call.input as { accountId: string }).accountId === id),
      )
    ) {
      await setTimeout(25, undefined, { signal: ctx.abortSignal });
      return;
    }
    await setTimeout(50, undefined, { signal: ctx.abortSignal });
  }
  throw new Error("Balance service timed out");
}
