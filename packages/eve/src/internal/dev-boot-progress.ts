export type DevBootProgressEvent =
  | {
      readonly phase: string;
      readonly type: "phase-started";
    }
  | {
      readonly elapsedMs: number;
      readonly phase: string;
      readonly type: "phase-finished";
    }
  | {
      readonly type: "before-first-paint";
    };

export type DevBootProgressReporter = (event: DevBootProgressEvent) => void;

/** Runs one measured boot phase and reports it to this invocation's observer. */
export async function devBootPhase<T>(
  phase: string,
  run: () => Promise<T>,
  report?: DevBootProgressReporter,
): Promise<T> {
  if (report === undefined) return await run();

  const startedAt = Date.now();
  report({ phase, type: "phase-started" });
  try {
    return await run();
  } finally {
    report({ elapsedMs: Date.now() - startedAt, phase, type: "phase-finished" });
  }
}
