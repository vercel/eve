import { resolveTeamsAppPassword, type TeamsAppPassword } from "#public/channels/teams/api.js";

/** Teams HITL signing secret, materialized directly or from an async provider. */
export type TeamsHitlSecret = string | (() => string | Promise<string>);

/** Resolves and validates the secret used to sign Teams HITL routing data. */
export async function resolveTeamsHitlSecret(input: {
  readonly appPassword?: TeamsAppPassword;
  readonly hitlSecret?: TeamsHitlSecret;
}): Promise<string> {
  const source = input.hitlSecret;
  const secret =
    source === undefined
      ? await resolveTeamsAppPassword(input.appPassword)
      : typeof source === "function"
        ? await source()
        : source;
  if (secret.trim().length === 0) {
    throw new Error("teamsChannel: the HITL signing secret must not be empty.");
  }
  return secret;
}
