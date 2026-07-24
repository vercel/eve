export interface ShutdownSignal {
  readonly received: Promise<void>;
  readonly signal: AbortSignal;
  dispose(): void;
}

export function listenForShutdownSignal(): ShutdownSignal {
  const controller = new AbortController();
  let resolveSignal: (() => void) | undefined;
  const received = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const dispose = () => {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  };
  const handleSignal = () => {
    if (resolveSignal === undefined) {
      return;
    }

    // Keep handling the signal until the caller finishes cleanup. Other exit
    // listeners may re-raise it when no application listener remains.
    controller.abort();
    resolveSignal();
    resolveSignal = undefined;
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  return { dispose, received, signal: controller.signal };
}

export async function waitForShutdownSignal(input: { close(): Promise<void> }): Promise<void> {
  const shutdownSignal = listenForShutdownSignal();
  try {
    await shutdownSignal.received;
    await input.close();
  } finally {
    shutdownSignal.dispose();
  }
}
