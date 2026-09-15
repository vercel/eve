/** Local first-use boundary for Vercel Connect connections that need project identity. */
export class VercelProjectLinkRequiredError extends Error {
  readonly connectionName: string;

  constructor(connectionName: string) {
    super(
      `Connection "${connectionName}" requires this project to be linked to Vercel. Run \`eve link\`, then retry.`,
    );
    this.name = "VercelProjectLinkRequiredError";
    this.connectionName = connectionName;
  }
}

export function isVercelProjectLinkRequiredError(
  error: unknown,
): error is VercelProjectLinkRequiredError {
  return error instanceof Error && error.name === "VercelProjectLinkRequiredError";
}
