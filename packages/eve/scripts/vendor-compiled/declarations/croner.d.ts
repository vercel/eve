export class Cron {
  constructor(
    pattern: string,
    options: { timezone: string; unref?: boolean },
    callback: () => void | Promise<void>,
  );
  stop(): void;
}
