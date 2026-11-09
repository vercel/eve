import { verifyHttpBasic } from "eve/channels/auth";

type Principal = {
  authenticator: string;
  principalId: string;
  attributes: Record<string, unknown>;
} | null;

const HTTP_OPERATOR = "company-brain";

function isDevelopment(env: NodeJS.ProcessEnv): boolean {
  return env.EVE_DEV === "1" || (env.VERCEL === "1" && env.VERCEL_ENV === "development");
}

export function authenticateDevelopmentHttp(request: Request, env: NodeJS.ProcessEnv) {
  const password = env.COMPANY_BRAIN_HTTP_PASSWORD;
  if (!isDevelopment(env) || !password) return null;
  const result = verifyHttpBasic(request.headers.get("authorization"), {
    username: HTTP_OPERATOR,
    password,
  });
  return result.ok ? result.sessionAuth : null;
}

function parseIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function canReadModels(auth: Principal, env: NodeJS.ProcessEnv): boolean {
  if (!auth) return false;
  if (auth.authenticator === "http-basic" && auth.principalId === HTTP_OPERATOR) {
    return isDevelopment(env) && Boolean(env.COMPANY_BRAIN_HTTP_PASSWORD);
  }
  if (auth.authenticator !== "slack-webhook") return false;

  const channel = auth.attributes.channel_id;
  if (!env.SLACK_TEAM_ID || typeof channel !== "string") return false;

  const allowedChannels = parseIds(env.SLACK_ALLOWED_CHANNEL_IDS);
  const allowedPrincipals = parseIds(env.SLACK_ALLOWED_USER_IDS).map(
    (user) => `slack:${env.SLACK_TEAM_ID}:${user}`,
  );
  return allowedChannels.includes(channel) && allowedPrincipals.includes(auth.principalId);
}

export function requireModelAccess(auth: Principal): void {
  if (!canReadModels(auth, process.env))
    throw new Error(
      "Access denied. Ask the operator to configure HTTP credentials or your Slack user and conversation allowlists.",
    );
}
