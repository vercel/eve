export interface BenchmarkTiming {
  readonly phase: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: "success" | "failure";
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export class BenchmarkTimings {
  readonly entries: BenchmarkTiming[] = [];

  async measure<T>(
    phase: string,
    operation: () => Promise<T>,
    details?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<T> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    try {
      const result = await operation();
      this.entries.push({
        phase,
        startedAt,
        durationMs: Math.round(performance.now() - started),
        outcome: "success",
        ...(details === undefined ? {} : { details }),
      });
      return result;
    } catch (error) {
      this.entries.push({
        phase,
        startedAt,
        durationMs: Math.round(performance.now() - started),
        outcome: "failure",
        ...(details === undefined ? {} : { details }),
      });
      throw error;
    }
  }

  record(
    phase: string,
    durationMs: number,
    outcome: BenchmarkTiming["outcome"] = "success",
    details?: Readonly<Record<string, string | number | boolean>>,
  ): void {
    this.entries.push({
      phase,
      startedAt: new Date(Date.now() - durationMs).toISOString(),
      durationMs: Math.round(durationMs),
      outcome,
      ...(details === undefined ? {} : { details }),
    });
  }
}
