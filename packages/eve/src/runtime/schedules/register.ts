import type { ResolvedScheduleDefinition } from "#runtime/types.js";

/**
 * Stable Nitro task-name prefix for framework-owned authored schedules.
 */
export const EVE_SCHEDULE_TASK_NAME_PREFIX = "eve.schedule.";

/**
 * One compiled schedule registration consumed by the Nitro host wiring.
 */
export interface ScheduleRegistration {
  readonly cron: string;
  readonly description: string;
  readonly logicalPath: string;
  readonly scheduleId: string;
  readonly sourceId: string;
  readonly taskName: string;
}

/**
 * Error raised when authored schedules cannot be converted into stable runtime
 * registrations.
 */
export class ScheduleRegistrationError extends Error {
  readonly scheduleId?: string;
  readonly sourceId?: string;
  readonly taskName?: string;

  constructor(
    message: string,
    input: {
      scheduleId?: string;
      sourceId?: string;
      taskName?: string;
    } = {},
  ) {
    super(message);
    this.name = "ScheduleRegistrationError";

    if (input.scheduleId !== undefined) {
      this.scheduleId = input.scheduleId;
    }

    if (input.sourceId !== undefined) {
      this.sourceId = input.sourceId;
    }

    if (input.taskName !== undefined) {
      this.taskName = input.taskName;
    }
  }
}

/**
 * Creates stable registration inputs for Nitro's task and cron surfaces from
 * resolved authored schedules.
 */
export function createScheduleRegistrations(
  schedules: readonly ResolvedScheduleDefinition[],
): ScheduleRegistration[] {
  const registrations = schedules
    .map((schedule) => ({
      cron: schedule.cron,
      description: `Run eve schedule "${schedule.name}" from "${schedule.logicalPath}".`,
      logicalPath: schedule.logicalPath,
      scheduleId: schedule.name,
      sourceId: schedule.sourceId,
      taskName: createScheduleTaskName(schedule.sourceId),
    }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));

  assertUniqueScheduleIds(registrations);

  return registrations;
}

function assertUniqueScheduleIds(registrations: readonly ScheduleRegistration[]): void {
  const registrationByScheduleId = new Map<string, ScheduleRegistration>();

  for (const registration of registrations) {
    const previousRegistration = registrationByScheduleId.get(registration.scheduleId);

    if (previousRegistration === undefined) {
      registrationByScheduleId.set(registration.scheduleId, registration);
      continue;
    }

    throw new ScheduleRegistrationError(
      `Duplicate authored schedule id "${registration.scheduleId}" found in "${previousRegistration.logicalPath}" and "${registration.logicalPath}".`,
      {
        scheduleId: registration.scheduleId,
        sourceId: registration.sourceId,
        taskName: registration.taskName,
      },
    );
  }
}

function createScheduleTaskName(sourceId: string): string {
  return `${EVE_SCHEDULE_TASK_NAME_PREFIX}${Buffer.from(sourceId, "utf8").toString("base64url")}`;
}
