import { keptRunningUntil, type SandboxRunning } from "#sandbox/state.js";

export const SANDBOX_CHECK_INTERVAL_MS = 5 * 60_000;

export interface SandboxSchedule {
  readonly idleEndsAt?: number;
  readonly nextCheckAt?: number;
  readonly stopTriedAt?: number;
}

export interface SandboxCheckPlan {
  readonly at: number;
  readonly stop: boolean;
}

export function planSandboxCheck(
  schedule: SandboxSchedule,
  facts: {
    readonly idle: boolean;
    readonly now: number;
    readonly running: SandboxRunning | undefined;
  },
): { readonly schedule: SandboxSchedule; readonly check?: SandboxCheckPlan } {
  const { idle, now, running } = facts;
  if (running === undefined) return { schedule: {} };
  const keptUntil = keptRunningUntil(running, now);
  if (keptUntil === undefined) {
    const stopTried =
      schedule.stopTriedAt !== undefined &&
      keptRunningUntil(running, schedule.stopTriedAt) === undefined;
    const waiting = { idleEndsAt: schedule.idleEndsAt, stopTriedAt: schedule.stopTriedAt };
    if (!idle || stopTried) return { schedule: waiting };
    const idleEndsAt = schedule.idleEndsAt ?? now + running.idleTimeoutMs;
    return {
      schedule: { ...waiting, idleEndsAt },
      check: { at: Math.max(idleEndsAt, now), stop: true },
    };
  }
  const idleEndsAt = idle
    ? (schedule.idleEndsAt ?? now + running.idleTimeoutMs)
    : schedule.idleEndsAt;
  let nextCheckAt = schedule.nextCheckAt ?? now + SANDBOX_CHECK_INTERVAL_MS;
  if (idle && schedule.idleEndsAt === undefined && idleEndsAt !== undefined)
    nextCheckAt = Math.min(nextCheckAt, idleEndsAt);
  const at = Math.max(Math.min(nextCheckAt, keptUntil), now);
  return {
    schedule: { idleEndsAt, nextCheckAt, stopTriedAt: schedule.stopTriedAt },
    check: { at, stop: idle && idleEndsAt !== undefined && idleEndsAt <= at },
  };
}

export function sandboxCheckStarted(
  schedule: SandboxSchedule,
  check: SandboxCheckPlan,
): SandboxSchedule {
  return {
    idleEndsAt: schedule.idleEndsAt,
    stopTriedAt: check.stop ? check.at : schedule.stopTriedAt,
  };
}

export function sandboxTurnStarted(schedule: SandboxSchedule): SandboxSchedule {
  return { nextCheckAt: schedule.nextCheckAt };
}
