import type { SessionAuthContext } from "eve/context";

export interface SlackUserIdentity {
  principalId: string;
  teamId: string;
}

export type SlackUserAuthLike = Partial<
  Pick<
    SessionAuthContext,
    "attributes" | "authenticator" | "issuer" | "principalId" | "principalType"
  >
>;

export function resolveSlackUser(
  auth: SlackUserAuthLike | null | undefined
): SlackUserIdentity | null {
  if (
    auth?.authenticator !== "slack-webhook" ||
    auth.principalType !== "user"
  ) {
    return null;
  }

  const principalId = auth.principalId?.trim() ?? "";
  const rawTeamId = auth.attributes?.team_id;
  const teamId = typeof rawTeamId === "string" ? rawTeamId.trim() : "";
  if (!(principalId && teamId) || auth.issuer !== `slack:${teamId}`) {
    return null;
  }

  return { principalId, teamId };
}

export function createServiceAuth(input: {
  authenticator: string;
  principalId: string;
}): SessionAuthContext {
  return {
    attributes: {},
    authenticator: input.authenticator,
    principalId: input.principalId,
    principalType: "service",
  };
}
