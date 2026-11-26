import { PermanentScheduleMessageError } from "#internal/schedules/verify-delivery.js";
import { ScheduleCollectionNotDeployedError } from "#runtime/schedules/load-collection.js";
import { parseSchedulePayload } from "#runtime/schedules/payload.js";

export const LOCAL_DEV_SCHEDULE_MAX_ATTEMPTS = 3;
export const LOCAL_DEV_SCHEDULE_RETRY_DELAY_MS = 2_000;

export function parsePersistedSchedulePayload(
  value: unknown,
  expected: { readonly application: string; readonly collection: string },
) {
  try {
    return parseSchedulePayload<unknown>(value, expected);
  } catch (error) {
    throw new PermanentScheduleMessageError(
      error instanceof Error ? error.message : "Scheduled collection request is invalid.",
    );
  }
}

export function createLocalDevScheduleDispatcher<Claim>(options: {
  readonly deliver: (claim: Claim) => Promise<void>;
  readonly fail: (claim: Claim, reason: string, attempts: number) => Promise<void>;
  readonly isClosed: () => boolean;
  readonly sleep: (ms: number) => Promise<unknown>;
}): (claim: Claim) => Promise<void> {
  return async (claim) => {
    for (let attempt = 1; ; attempt++) {
      try {
        await options.deliver(claim);
        return;
      } catch (error) {
        if (options.isClosed()) return;
        const permanent =
          error instanceof PermanentScheduleMessageError ||
          error instanceof ScheduleCollectionNotDeployedError;
        if (permanent || attempt >= LOCAL_DEV_SCHEDULE_MAX_ATTEMPTS) {
          const reason = error instanceof Error ? error.message : "Scheduled occurrence failed.";
          await options.fail(claim, reason, attempt);
          return;
        }
        await options.sleep(LOCAL_DEV_SCHEDULE_RETRY_DELAY_MS * attempt);
      }
    }
  };
}
