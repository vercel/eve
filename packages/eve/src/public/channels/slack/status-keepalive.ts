export const SLACK_STATUS_KEEPALIVE_REFRESH_INTERVAL_MS = 75_000;
const STATUS_KEEPALIVE_MAX_LIFETIME_MS = 12 * 60_000;

interface StatusKeepaliveEntry {
  refresh: (status: string) => Promise<void>;
  startedAt: number;
  status: string;
}

interface StatusKeepaliveSeams {
  readonly now: () => number;
  readonly sleep: (durationMs: number) => Promise<void>;
}

const entries = new Map<string, StatusKeepaliveEntry>();
let seams: StatusKeepaliveSeams = {
  now: Date.now,
  sleep: defaultSleep,
};

/** @internal Test seam for the Slack status keepalive. */
export function setSlackStatusKeepaliveTestSeams(overrides?: Partial<StatusKeepaliveSeams>): void {
  entries.clear();
  seams = {
    now: overrides?.now ?? Date.now,
    sleep: overrides?.sleep ?? defaultSleep,
  };
}

export function startSlackStatusKeepalive(input: {
  readonly key: string;
  readonly refresh: (status: string) => Promise<void>;
  readonly status: string;
}): void {
  const existing = entries.get(input.key);
  if (existing !== undefined) {
    existing.refresh = input.refresh;
    existing.startedAt = seams.now();
    existing.status = input.status;
    return;
  }

  const entry: StatusKeepaliveEntry = {
    refresh: input.refresh,
    startedAt: seams.now(),
    status: input.status,
  };
  entries.set(input.key, entry);

  void runStatusKeepalive(input.key, entry).catch(() => {
    if (entries.get(input.key) === entry) entries.delete(input.key);
  });
}

export function stopSlackStatusKeepalive(key: string): void {
  entries.delete(key);
}

async function runStatusKeepalive(key: string, entry: StatusKeepaliveEntry): Promise<void> {
  while (seams.now() - entry.startedAt < STATUS_KEEPALIVE_MAX_LIFETIME_MS) {
    await seams.sleep(SLACK_STATUS_KEEPALIVE_REFRESH_INTERVAL_MS);
    if (entries.get(key) !== entry) return;
    await entry.refresh(entry.status);
  }
  if (entries.get(key) === entry) entries.delete(key);
}

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, durationMs);
    timer.unref?.();
  });
}
