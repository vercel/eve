export function isVercelSnapshotUnavailableError(error: unknown): boolean {
  return errorChainContainsStatus(error, 410);
}

/**
 * A resume that found the sandbox's snapshot expired or deleted: 410 with the
 * `snapshot_not_found` code, rather than any other 410.
 */
export function isVercelSnapshotNotFoundError(error: unknown): boolean {
  for (const candidate of walkErrorChain(error)) {
    if (readErrorStatus(candidate) !== 410 || !isRecord(candidate)) continue;
    const body =
      isRecord(candidate.json) && isRecord(candidate.json.error) ? candidate.json.error : undefined;
    if (body?.code === "snapshot_not_found") return true;
  }
  return false;
}

/**
 * A create that lost the race for a sandbox name. The Sandbox API answers a
 * taken name with 400 `bad_request` "A sandbox with the name '…' already
 * exists"; 409 is accepted too in case it moves to a proper Conflict.
 */
export function isVercelSandboxNameConflictError(error: unknown): boolean {
  for (const candidate of walkErrorChain(error)) {
    const status = readErrorStatus(candidate);
    if (status === 409) return true;
    if (
      status === 400 &&
      /\bsandbox with the name\b.*\balready exists\b/is.test(readErrorText(candidate))
    ) {
      return true;
    }
  }
  return false;
}

// The API error's message, falling back to its parsed JSON body.
function readErrorText(value: unknown): string {
  if (!isRecord(value)) return "";
  const parts: string[] = [];
  if (typeof value.message === "string") parts.push(value.message);
  if (typeof value.text === "string") parts.push(value.text);
  const body = isRecord(value.json) && isRecord(value.json.error) ? value.json.error : undefined;
  if (body !== undefined && typeof body.message === "string") parts.push(body.message);
  return parts.join("\n");
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

export function isVercelResourcePendingError(error: unknown): boolean {
  return errorChainContainsStatus(error, 409);
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
