export const EVE_SCHEDULES_DISABLED_ENV = "EVE_SCHEDULES_DISABLED";

export function areSchedulesDisabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env[EVE_SCHEDULES_DISABLED_ENV]?.toLowerCase();
  return value === "1" || value === "true";
}
