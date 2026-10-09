import {
  hashEveTelemetryProject,
  isEphemeralEveTelemetryEnvironment,
} from "#cli/telemetry/identity.js";
import {
  readEveTelemetryInternalTeam,
  readOrCreateEveTelemetryIdentity,
  writeEveTelemetryInternalTeam,
} from "#cli/telemetry/preference.js";
import { readVercelCliFileConnection } from "#internal/model-auth/vercel-cli.js";
import { isObject } from "#shared/guards.js";

const INTERNAL_EMAIL_DOMAIN = "vercel.com";
const REQUEST_TIMEOUT_MS = 1_000;
const FAILED_LOOKUP_RETRY_MS = 24 * 60 * 60 * 1_000;

/**
 * Whether the team selected in the Vercel CLI auto-admits `vercel.com` sign-ups, so Vercel
 * can exclude its own usage. `EVE_TELEMETRY_INTERNAL=1` marks an internal environment outright.
 * Undefined when eve cannot tell: no selected team, no file-stored CLI login, an ephemeral
 * environment, or a failed lookup. A result is reused until the selected team changes, and a
 * failed lookup is retried after a day. Only a salted hash of the team ID is saved, never the
 * ID itself, and neither is ever sent.
 */
export async function resolveEveTelemetryInternal(): Promise<boolean | undefined> {
  const flag = process.env.EVE_TELEMETRY_INTERNAL?.trim().toLowerCase();
  if (flag === "1" || flag === "true") return true;
  if (isEphemeralEveTelemetryEnvironment()) return undefined;
  const connection = await readVercelCliFileConnection();
  if (connection === undefined) return undefined;
  try {
    const teamHash = hashEveTelemetryProject(
      await readOrCreateEveTelemetryIdentity(),
      connection.teamId,
    );
    const saved = await readEveTelemetryInternalTeam();
    if (
      saved?.teamHash === teamHash &&
      (saved.internal !== undefined || Date.now() - saved.checkedAt < FAILED_LOOKUP_RETRY_MS)
    ) {
      return saved.internal;
    }
    const response = await fetch(
      `https://api.vercel.com/v2/teams/${encodeURIComponent(connection.teamId)}`,
      {
        headers: { authorization: `Bearer ${connection.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    let internal: boolean | undefined;
    if (response.ok) {
      const team: unknown = await response.json();
      internal = isObject(team) && team.emailDomain === INTERNAL_EMAIL_DOMAIN;
    }
    await writeEveTelemetryInternalTeam({ teamHash, internal, checkedAt: Date.now() }).catch(
      () => {},
    );
    return internal;
  } catch {
    return undefined;
  }
}
