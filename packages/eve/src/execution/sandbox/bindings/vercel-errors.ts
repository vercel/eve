export function isVercelSnapshotUnavailableError(error: unknown): boolean {
  for (const candidate of walkErrorChain(error)) {
    const status =
      (candidate as { response?: { status?: number } }).response?.status ??
      (candidate as { status?: number }).status ??
      (candidate as { statusCode?: number }).statusCode;
    if (status === 410) {
      return true;
    }
  }

  return false;
}

export function isVercelSandboxMissingError(error: unknown): boolean {
  for (const candidate of walkErrorChain(error)) {
    const status =
      (candidate as { response?: { status?: number } }).response?.status ??
      (candidate as { status?: number }).status ??
      (candidate as { statusCode?: number }).statusCode;
    if (status === 404) {
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
    current = (current as { cause?: unknown }).cause;
  }
}
