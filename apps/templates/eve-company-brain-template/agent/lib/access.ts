type Principal = { principalId: string; attributes: Record<string, unknown> } | null;

function parseIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function canReadModels(auth: Principal, env: NodeJS.ProcessEnv): boolean {
  if (!auth) return false;
  if (auth.principalId === "local-dev") {
    return env.EVE_DEV === "1" || (env.VERCEL === "1" && env.VERCEL_ENV === "development");
  }

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
      "Access denied. Ask the operator to configure your Slack user and conversation allowlists.",
    );
}
