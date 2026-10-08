import { isEphemeralEveTelemetryEnvironment } from "#cli/telemetry/identity.js";
import {
  readEveTelemetryInternalTeam,
  writeEveTelemetryInternalTeam,
} from "#cli/telemetry/preference.js";
import { readVercelCliTeam, readVercelCliToken } from "#internal/model-auth/vercel-cli.js";
import { isObject } from "#shared/guards.js";

const INTERNAL_EMAIL_DOMAIN = "vercel.com";
const REQUEST_TIMEOUT_MS = 1_000;

/**
 * Whether the team selected in the Vercel CLI auto-admits `vercel.com` sign-ups, so Vercel
 * can exclude its own usage. `EVE_TELEMETRY_INTERNAL` marks an internal environment outright.
 * Undefined when eve cannot tell: no selected team, no CLI login, an ephemeral environment,
 * or a failed lookup. A result is reused until the selected team changes.
 */
export async function resolveEveTelemetryInternal(): Promise<boolean | undefined> {
  if (process.env.EVE_TELEMETRY_INTERNAL) return true;
  if (isEphemeralEveTelemetryEnvironment()) return undefined;
  const teamId = await readVercelCliTeam();
  if (teamId === undefined) return undefined;
  const saved = await readEveTelemetryInternalTeam();
  if (saved?.teamId === teamId) return saved.internal;
  const token = await readVercelCliToken();
  if (token === undefined) return undefined;
  try {
    const response = await fetch(`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const team: unknown = await response.json();
    const internal = isObject(team) && team.emailDomain === INTERNAL_EMAIL_DOMAIN;
    await writeEveTelemetryInternalTeam({ teamId, internal }).catch(() => {});
    return internal;
  } catch {
    return undefined;
  }
}
