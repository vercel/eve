import { setTimeout as delay } from "node:timers/promises";
import { isObject } from "#shared/guards.js";
import {
  authJson,
  vercelApiJson,
  vercelOAuthEndpoints,
  sessionFromToken,
  validateVercelAccess,
  VERCEL_MODEL_CLIENT_ID,
  VERCEL_OAUTH_ISSUER,
} from "#internal/model-auth/vercel.js";
import { readVercelCliTeam } from "#internal/model-auth/vercel-cli.js";
import { writeVercelSession } from "#internal/model-auth/store.js";
import { withLoginProgress } from "./model-login-progress.js";
import { rememberModelTeamSlug } from "#internal/model-auth/vercel-team.js";
import { openUrl } from "#setup/primitives/open-url.js";
import type { Prompter } from "#setup/prompter.js";

export async function loginVercelModel(
  prompter: Prompter,
  signal?: AbortSignal,
  preferredTeamId?: string,
): Promise<{ teamId: string; teamName: string }> {
  const { endpoints, device } = await withLoginProgress(
    prompter,
    "Opening Vercel sign-in…",
    async () => {
      const endpoints = await vercelOAuthEndpoints(signal);
      const device = await authJson(endpoints.device, {
        method: "POST",
        body: new URLSearchParams({
          client_id: VERCEL_MODEL_CLIENT_ID,
          scope: "openid offline_access",
        }),
        signal,
      });
      return { endpoints, device };
    },
  );
  if (
    typeof device.device_code !== "string" ||
    typeof device.verification_uri !== "string" ||
    typeof device.user_code !== "string"
  )
    throw new Error("Could not start Vercel sign-in. Retry /login.");
  const url =
    typeof device.verification_uri_complete === "string"
      ? device.verification_uri_complete
      : device.verification_uri;
  const parsed = URL.parse(url);
  if (parsed?.origin !== VERCEL_OAUTH_ISSUER)
    throw new Error("Vercel returned an unexpected sign-in URL. Retry /login.");
  prompter.log.info(`Open ${url} · code ${device.user_code}`);
  openUrl(url);
  let interval =
    typeof device.interval === "number" ? Math.max(1, Math.min(30, device.interval)) : 5;
  const duration = typeof device.expires_in === "number" ? Math.min(600, device.expires_in) : 300;
  const deadline = Date.now() + duration * 1000;
  const spinner = prompter.log.spinner?.("Finish signing in to Vercel in your browser", {
    kind: "external-action",
    emphasis: "your browser",
  });
  let session;
  try {
    while (Date.now() < deadline) {
      await delay(interval * 1000, undefined, { signal });
      const token = await authJson(endpoints.token, {
        method: "POST",
        body: new URLSearchParams({
          client_id: VERCEL_MODEL_CLIENT_ID,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
        }),
        signal,
      });
      if (token.error === "authorization_pending") continue;
      if (token.error === "slow_down") {
        interval = Math.min(30, interval + 5);
        continue;
      }
      if (token.error) throw new Error("Vercel sign-in was declined or expired. Retry /login.");
      session = sessionFromToken(token);
      break;
    }
  } finally {
    spinner?.stop();
  }
  if (!session) throw new Error("Vercel sign-in timed out. Retry /login.");
  const [teams, cliTeam] = await withLoginProgress(prompter, "Loading Vercel teams…", () =>
    Promise.all([loadTeams(session.accessToken, signal), readVercelCliTeam()]),
  );
  const preferred =
    teams.find((team) => team.id === preferredTeamId) ?? teams.find((team) => team.id === cliTeam);
  let team = teams.length === 1 ? teams[0] : undefined;
  while (true) {
    if (!team) {
      const id = await prompter.select({
        message: "Choose a Vercel team",
        search: true,
        initialValue: preferred?.id,
        options: teams.map((team) => ({ value: team.id, label: team.name })),
      });
      team = teams.find((candidate) => candidate.id === id);
    }
    if (!team) throw new Error("That Vercel team is no longer available. Retry /login.");
    const selectedTeam = team;
    try {
      await withLoginProgress(
        prompter,
        `Checking AI Gateway access for ${team.slug ?? team.name}…`,
        () => validateVercelAccess(session.accessToken, selectedTeam.id, signal),
      );
      break;
    } catch (error) {
      signal?.throwIfAborted();
      if (teams.length === 1) throw error;
      prompter.log.warning(
        "AI Gateway is unavailable for that team. Choose another team or press Esc to return.",
      );
      team = undefined;
    }
  }
  session.teamId = team.id;
  session.teamName = team.name;
  signal?.throwIfAborted();
  await writeVercelSession(session, VERCEL_MODEL_CLIENT_ID);
  if (team.slug) rememberModelTeamSlug(team.id, team.slug);
  return { teamId: team.id, teamName: team.name };
}

async function loadTeams(token: string, signal?: AbortSignal) {
  const teams: { id: string; name: string; slug?: string }[] = [];
  let until: number | undefined;
  for (let page = 0; page < 20; page++) {
    const data = await vercelApiJson(
      `https://api.vercel.com/v2/teams?limit=100${until === undefined ? "" : `&until=${until}`}`,
      { headers: { authorization: `Bearer ${token}` }, signal },
    );
    if (!Array.isArray(data.teams)) throw new Error("Could not list Vercel teams. Retry /login.");
    for (const team of data.teams) {
      if (isObject(team) && typeof team.id === "string" && typeof team.name === "string")
        teams.push({
          id: team.id,
          name: team.name,
          slug: typeof team.slug === "string" ? team.slug : undefined,
        });
    }
    until =
      isObject(data.pagination) && typeof data.pagination.next === "number"
        ? data.pagination.next
        : undefined;
    if (until === undefined) break;
  }
  if (teams.length === 0)
    throw new Error(
      "No Vercel team is available. Join a team or choose another connection in /login.",
    );
  return teams;
}
