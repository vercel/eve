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
      const entry: {
        phase: string;
        startedAt: string;
        durationMs: number;
        outcome: BenchmarkTiming["outcome"];
        details?: Readonly<Record<string, string | number | boolean>>;
      } = {
        phase,
        startedAt,
        durationMs: Math.round(performance.now() - started),
        outcome: "success",
      };
      if (details !== undefined) entry.details = details;
      this.entries.push(entry);
      return result;
    } catch (error) {
      const entry: {
        phase: string;
        startedAt: string;
        durationMs: number;
        outcome: BenchmarkTiming["outcome"];
        details?: Readonly<Record<string, string | number | boolean>>;
      } = {
        phase,
        startedAt,
        durationMs: Math.round(performance.now() - started),
        outcome: "failure",
      };
      if (details !== undefined) entry.details = details;
      this.entries.push(entry);
      throw error;
    }
  }

  record(
    phase: string,
    durationMs: number,
    outcome: BenchmarkTiming["outcome"] = "success",
    details?: Readonly<Record<string, string | number | boolean>>,
  ): void {
    const entry: {
      phase: string;
      startedAt: string;
      durationMs: number;
      outcome: BenchmarkTiming["outcome"];
      details?: Readonly<Record<string, string | number | boolean>>;
    } = {
      phase,
      startedAt: new Date(Date.now() - durationMs).toISOString(),
      durationMs: Math.round(durationMs),
      outcome,
    };
    if (details !== undefined) entry.details = details;
    this.entries.push(entry);
  }
}
