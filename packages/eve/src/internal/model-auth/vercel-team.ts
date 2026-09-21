import { resolveVercelSession, vercelApiJson } from "./vercel.js";
import { readVercelCliConnection } from "./vercel-cli.js";
import { readVercelResourceSlug } from "#internal/vercel/api-resource.js";

let knownTeam: { teamId: string; slug: string } | undefined;

export function rememberModelTeamSlug(teamId: string, slug: string): void {
  knownTeam = { teamId, slug };
}

/** Resolves display metadata without changing credentials or linking a project. */
export async function resolveModelTeamSlug(signal?: AbortSignal): Promise<string | undefined> {
  const selected = process.env.EVE_MODEL_CONNECTION;
  if (selected !== "vercel" && selected !== "vercel-cli") return undefined;
  const selectedTeam = process.env.EVE_MODEL_TEAM;
  if (selectedTeam && knownTeam?.teamId === selectedTeam) return knownTeam.slug;
  const credential =
    selected === "vercel" ? await resolveVercelSession() : await readVercelCliConnection();
  if (!credential) return undefined;
  const teamId = process.env.EVE_MODEL_TEAM ?? credential.teamId;
  if (knownTeam?.teamId === teamId) return knownTeam.slug;
  const token = "accessToken" in credential ? credential.accessToken : credential.token;
  const team = await vercelApiJson(
    `https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal,
    },
  );
  return readVercelResourceSlug(team);
}
