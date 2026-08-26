export interface BenchmarkTiming {
  readonly phase: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: "success" | "failure";
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

type TimingDetails = BenchmarkTiming["details"];

export class BenchmarkTimings {
  readonly entries: BenchmarkTiming[] = [];

  async measure<T>(
    phase: string,
    operation: () => Promise<T>,
    details?: TimingDetails,
  ): Promise<T> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    try {
      const result = await operation();
      this.add(phase, startedAt, performance.now() - started, "success", details);
      return result;
    } catch (error) {
      this.add(phase, startedAt, performance.now() - started, "failure", details);
      throw error;
    }
  }

  record(
    phase: string,
    durationMs: number,
    outcome: BenchmarkTiming["outcome"] = "success",
    details?: TimingDetails,
  ): void {
    this.add(phase, new Date(Date.now() - durationMs).toISOString(), durationMs, outcome, details);
  }

  private add(
    phase: string,
    startedAt: string,
    durationMs: number,
    outcome: BenchmarkTiming["outcome"],
    details: TimingDetails,
  ): void {
    const entry = {
      phase,
      startedAt,
      durationMs: Math.round(durationMs),
      outcome,
    };
    this.entries.push(details === undefined ? entry : { ...entry, details });
  }
}
