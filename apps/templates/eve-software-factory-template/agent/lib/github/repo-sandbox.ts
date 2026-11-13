import type { VercelSandboxSession } from "eve/sandbox/vercel";
import {
  VercelSandbox,
  type VercelSandboxEnvironmentOptions,
} from "eve/sandbox/vercel";
import { FACTORY_REPO } from "../constants.js";
import {
  appAccessMessage,
  describeCloneFailure,
  safeErrorMessage,
  sanitizeCommandOutput,
} from "./bootstrap-diagnostics.js";
import { FALLBACK_BOT_NAME, resolveBotName } from "./bot-name.js";
import { githubCredentials } from "./credentials.js";
import {
  brokerPolicy,
  mintInstallationToken,
  REMOTE_URL,
} from "./git-remote.js";

// Snapshot settings shared by every factory sandbox environment. One kept
// snapshot keeps storage flat across template rebuilds; the 14-day expiration
// (Vercel removes unresumable sandboxes after 14 days anyway) stops a quiet
// stretch from expiring the template.
export const FACTORY_SANDBOX_CREATE_OPTIONS = {
  keepLastSnapshots: { count: 1, deleteEvicted: true },
  resources: { vcpus: 4 },
  snapshotExpiration: 14 * 24 * 60 * 60 * 1000,
} satisfies VercelSandboxEnvironmentOptions;

/**
 * Creates a station's Vercel Sandbox environment.
 *
 * @remarks
 * Each station calls this from its own `sandbox.ts`, so the environment's
 * generation is keyed to that file, the same as authoring `VercelSandbox
 * .environment()` directly there would be.
 */
export function createFactoryEnvironment() {
  return VercelSandbox.environment(FACTORY_SANDBOX_CREATE_OPTIONS);
}

/**
 * Runs a command in the sandbox and throws on a nonzero exit, so a broken
 * clone or setup fails the session loudly instead of leaving a half-checked-
 * out repository behind.
 */
async function runOrThrow(
  sandbox: VercelSandboxSession,
  command: string
): Promise<void> {
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0) {
    throw new Error(
      sanitizeCommandOutput(
        `Sandbox command failed (exit ${result.exitCode}): ${command}\n${String(
          result.stderr || result.stdout
        ).trim()}`
      )
    );
  }
}

// Mints the brokered installation token, translating a refusal (typically
// "App authorization required" from Connect) into the actionable message.
// The original error rides along as the cause; the token itself never
// appears in either.
async function mintTokenOrExplain(
  mint: () => Promise<string>
): Promise<string> {
  try {
    return await mint();
  } catch (error) {
    throw new Error(appAccessMessage(FACTORY_REPO), { cause: error });
  }
}

/**
 * Characters allowed in a bot name interpolated into a shell-quoted git
 * config command.
 */
const SAFE_BOT_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The bot's commit identity, from the connector-resolved name.
 *
 * @remarks
 * Falls back to the static default when resolution fails (a commit identity
 * is needed even when the connector metadata is briefly unreachable) or when
 * the resolved name carries characters that don't belong in a shell-quoted
 * git config value; connector app slugs never do, but the name can also
 * arrive from an env override.
 */
async function gitIdentity(): Promise<{ email: string; name: string }> {
  const resolved = await resolveBotName().catch(() => FALLBACK_BOT_NAME);
  const safe = SAFE_BOT_NAME.test(resolved) ? resolved : FALLBACK_BOT_NAME;
  return {
    email: `${safe.toLowerCase()}[bot]@users.noreply.github.com`,
    name: `${safe}[bot]`,
  };
}

/**
 * Session-scoped setup shared by the analyst, implementer, and reviewer
 * sandboxes: fix git's ownership check, set the bot's commit identity, and
 * clone the factory repository.
 *
 * @remarks
 * - eve's build-time snapshot `prepare()` sandbox has no `setNetworkPolicy`
 *   (only a session-scoped sandbox from `environment.open()` does), so the
 *   credentialed clone that used to run once per template, shared by every
 *   session, now runs once per session instead: a session pays a full clone
 *   rather than the shallow fetch a pre-cloned snapshot used to leave it. The
 *   clone still authenticates through the sandbox firewall (the installation
 *   token is injected as a header transform and never enters the sandbox),
 *   and `FACTORY_SETUP_COMMAND` (e.g. `pnpm install`) still runs inside the
 *   fresh checkout when set.
 * - The template snapshot is owned by the builder uid, not the session user;
 *   without the `safe.directory` entries every git command dies on "dubious
 *   ownership".
 * - Failures are translated into messages that name `FACTORY_REPO` and the
 *   fix (see `bootstrap-diagnostics.ts`), keep the original error as the
 *   cause, and never carry the token.
 */
export async function factoryInit(
  sandbox: VercelSandboxSession
): Promise<void> {
  const identity = await gitIdentity();
  await runOrThrow(
    sandbox,
    `git config --global --add safe.directory /workspace && git config --global --add safe.directory /workspace/repo && git config --global user.name "${identity.name}" && git config --global user.email "${identity.email}"`
  );
  const token = await mintTokenOrExplain(() =>
    mintInstallationToken(githubCredentials)
  );
  await sandbox.setNetworkPolicy(brokerPolicy(token));
  try {
    try {
      await runOrThrow(sandbox, `git clone --depth 50 ${REMOTE_URL} repo`);
    } catch (error) {
      throw new Error(
        describeCloneFailure(FACTORY_REPO, safeErrorMessage(error)),
        { cause: error }
      );
    }
    const setup = process.env.FACTORY_SETUP_COMMAND;
    if (setup) {
      await runOrThrow(sandbox, `cd repo && ${setup}`);
    }
  } finally {
    await sandbox.setNetworkPolicy("allow-all");
  }
}
