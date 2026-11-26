export class Cron {
  constructor(
    pattern: string,
    options: { timezone: string; unref?: boolean },
    callback: () => void | Promise<void>,
  );
  nextRun(previous?: Date): Date | null;
  stop(): void;
}
