import { createDevelopmentServer } from "#internal/nitro/host.js";
import type { DevelopmentServerOptions } from "#internal/nitro/host/types.js";
import { getDevelopmentSandboxRunId } from "#execution/sandbox/development-run.js";
import { reconcileCleanupIntents, recordCleanupIntent } from "#cli/dev/local-server-cleanup.js";

const options = JSON.parse(process.argv[2] ?? "{}") as Pick<
  DevelopmentServerOptions,
  "existing" | "host" | "port"
>;
const server = createDevelopmentServer(process.cwd(), {
  ...options,
  onBootProgress: (event) => send({ type: "progress", event }),
});
let stopping = false;
let removeCleanupIntent: (() => Promise<void>) | undefined;
void reconcileCleanupIntents(process.cwd()).catch(() => undefined);

const send = (message: unknown) => {
  try {
    if (process.connected) process.send?.(message, () => {});
  } catch {}
};

const stop = () => {
  if (stopping) return;
  stopping = true;
  console.log = console.warn = console.error = () => {};
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  const cleanup = server.close();
  if (process.connected) process.disconnect?.();
  void cleanup.then(
    async () => {
      await intentReady.catch(() => undefined);
      await removeCleanupIntent?.().catch(() => undefined);
      process.exit(0);
    },
    () => process.exit(1),
  );
};

process.on("message", (message: { type?: string }) => {
  if (message.type === "shutdown") stop();
});
// IPC disconnect is the parent-death signal: it fires however the parent
// exits (including SIGKILL), which no portable OS mechanism covers.
process.once("disconnect", stop);
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

const intentReady = server.start().then(
  async (handle) => {
    const runId = getDevelopmentSandboxRunId();
    if (handle.kind === "started" && runId !== undefined) {
      removeCleanupIntent = await recordCleanupIntent(process.cwd(), {
        ownerPid: process.pid,
        runId,
      });
    }
    send({ type: "started", handle });
    if (handle.kind === "existing" && process.connected) process.disconnect?.();
  },
  (error: unknown) => {
    const value = error instanceof Error ? error : new Error(String(error));
    send({ type: "failed", message: value.message, stack: value.stack });
    process.exitCode = 1;
    if (process.connected) process.disconnect?.();
  },
);
void intentReady;
