/** Local first-use boundary for Vercel Connect connections that have no usable Vercel user. */
export class LocalVercelAuthRequiredError extends Error {
  readonly connectionName: string;

  constructor(connectionName: string) {
    super(`Connection "${connectionName}" requires local Vercel authentication.`);
    this.name = "LocalVercelAuthRequiredError";
    this.connectionName = connectionName;
  }
}

export function isLocalVercelAuthRequiredError(
  error: unknown,
): error is LocalVercelAuthRequiredError {
  return error instanceof Error && error.name === "LocalVercelAuthRequiredError";
}
