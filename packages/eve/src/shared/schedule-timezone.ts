export function validateScheduleTimezone(timezone: string): string {
  const normalized = timezone.trim();
  if (normalized.length === 0 || normalized.length > 50 || /^[+-]/.test(normalized)) {
    throw new Error("Schedule timezone must be a valid IANA timezone.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(0);
  } catch {
    throw new Error(`Invalid IANA timezone: ${normalized}`);
  }
  return normalized;
}
