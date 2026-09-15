export function isVercelSnapshotUnavailableError(error: unknown): boolean {
  return errorChainContainsStatus(error, 410);
}

export function isVercelResourceMissingError(error: unknown): boolean {
  return errorChainContainsStatus(error, 404);
}

export function isVercelSandboxMissingError(error: unknown): boolean {
  return isVercelResourceMissingError(error);
}

export function isVercelImageUnavailableError(error: unknown): boolean {
  return errorChainContainsStatus(error, 404) || errorChainContainsStatus(error, 410);
}

function errorChainContainsStatus(error: unknown, expectedStatus: number): boolean {
  for (const candidate of walkErrorChain(error)) {
    if (readErrorStatus(candidate) === expectedStatus) return true;
  }
  return false;
}

function readErrorStatus(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.status === "number") return value.status;
  if (typeof value.statusCode === "number") return value.statusCode;
  return isRecord(value.response) && typeof value.response.status === "number"
    ? value.response.status
    : undefined;
}

function* walkErrorChain(error: unknown): Generator<unknown> {
  let current = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = isRecord(current) ? current.cause : undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
