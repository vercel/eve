const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function assertSafeId(value: string, kind: "job" | "task"): string {
  if (!SAFE_ID.test(value) || value === "." || value === "..") {
    throw new Error(`${kind} name must be 1-128 path- and Docker-safe characters`);
  }
  return value;
}
