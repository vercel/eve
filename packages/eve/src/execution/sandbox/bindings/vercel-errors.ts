export function isVercelSnapshotUnavailableError(error: unknown): boolean {
  for (const candidate of walkErrorChain(error)) {
    if (readErrorStatus(candidate) === 410) {
      return true;
    }
  }

  return false;
}

export function isVercelSandboxMissingError(error: unknown): boolean {
  for (const candidate of walkErrorChain(error)) {
    if (readErrorStatus(candidate) === 404) {
      return true;
    }
  }

  return false;
}

function* walkErrorChain(error: unknown): Generator<unknown> {
  let current = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = readProperty(current, "cause");
  }
}

function readErrorStatus(value: unknown): number | undefined {
  const responseStatus = readProperty(readProperty(value, "response"), "status");
  const status =
    responseStatus ?? readProperty(value, "status") ?? readProperty(value, "statusCode");
  return typeof status === "number" ? status : undefined;
}

function readProperty(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}
