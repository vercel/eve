export const FORCED_EXIT_BACKSTOP_MS = 900;

export interface CommandLifecycle {
  readonly signal: AbortSignal;
  readonly stopped: Promise<NodeJS.Signals | undefined>;
  withTerminalLease?<T>(task: () => Promise<T>): Promise<T>;
  requestStop(): void;
  dispose(): void;
}

export function installShutdownSignal(
  input: {
    readonly exitAfterMs?: number;
    readonly onStop?: () => void;
  } = {},
): CommandLifecycle {
  const controller = new AbortController();
  const stopped = Promise.withResolvers<NodeJS.Signals | undefined>();
  let stopRequested = false;
  let signalCount = 0;
  let terminalLeaseDepth = 0;
  let backstop: NodeJS.Timeout | undefined;
  const stop = (signal?: NodeJS.Signals) => {
    if (stopRequested) return;
    stopRequested = true;
    input.onStop?.();
    controller.abort(signal);
    stopped.resolve(signal);
    if (input.exitAfterMs !== undefined) {
      backstop = setTimeout(
        () => process.exit(signal === undefined ? 0 : signal === "SIGINT" ? 130 : 143),
        input.exitAfterMs,
      );
    }
  };
  const handleSignal = (signal: NodeJS.Signals) => {
    if (terminalLeaseDepth > 0) return;
    signalCount += 1;
    if (signalCount > 1) process.exit(signal === "SIGINT" ? 130 : 143);
    stop(signal);
  };
  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return {
    signal: controller.signal,
    stopped: stopped.promise,
    async withTerminalLease<T>(task: () => Promise<T>): Promise<T> {
      terminalLeaseDepth += 1;
      try {
        return await task();
      } finally {
        terminalLeaseDepth -= 1;
      }
    },
    requestStop: () => stop(),
    dispose() {
      if (backstop !== undefined) clearTimeout(backstop);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}

export async function waitForShutdownSignal(input: {
  readonly close: () => Promise<void>;
  readonly wait?: () => Promise<void>;
}): Promise<void> {
  const lifecycle = installShutdownSignal();
  try {
    const outcome = await Promise.race([
      lifecycle.stopped.then(() => "signal" as const),
      input.wait?.().then(() => "stopped" as const) ?? new Promise<never>(() => {}),
    ]);
    if (outcome === "signal") await input.close();
  } finally {
    lifecycle.dispose();
  }
}
