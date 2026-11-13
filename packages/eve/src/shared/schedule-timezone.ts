/**
 * Validates an IANA timezone and returns its canonical name. `Intl` accepts any
 * casing and legacy aliases, so canonicalizing keeps values such as `"utc"` or
 * `"US/Pacific"` from reaching hosts that only accept canonical names.
 */
export function validateScheduleTimezone(timezone: string): string {
  const normalized = timezone.trim();
  if (normalized.length === 0 || normalized.length > 50 || /^[+-]/.test(normalized)) {
    throw new Error("Schedule timezone must be a valid IANA timezone.");
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: normalized }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`Invalid IANA timezone: ${normalized}`);
  }
}
