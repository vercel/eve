import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

const CONNECTOR = "mcp.linear.app/linear";
const USER_ISSUER = "app";

const connectAuth = connect({
  connector: CONNECTOR,
  validate: true,
  principalToSubject: (principal) =>
    principal.type === "user"
      ? { type: "user", id: principal.id, issuer: principal.issuer ?? USER_ISSUER }
      : { type: "app" },
});

async function completeAuthorizationWithRetry(
  opts: Parameters<NonNullable<typeof connectAuth.completeAuthorization>>[0],
) {
  const delays = [0, 500, 1000, 2000];
  let lastError: unknown;

  for (const delay of delays) {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      return await connectAuth.completeAuthorization!(opts);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  description: "Linear workspace: issues, projects, cycles, and comments.",
  auth: {
    ...connectAuth,
    completeAuthorization: completeAuthorizationWithRetry,
  },
});
