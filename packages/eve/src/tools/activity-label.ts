export function activityLabel(verb: string, value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return verb;
  const detail = String(value).trim();
  return detail === "" ? verb : `${verb} ${detail}`;
}
