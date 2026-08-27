import type { SandboxBootstrapContext, SandboxSession, SandboxSessionContext } from "eve/sandbox";
import type { VercelSandboxCreateOptions } from "eve/sandbox/vercel";
import { FACTORY_REPO } from "../constants.js";
import {
  appAccessMessage,
  describeCloneFailure,
  safeErrorMessage,
  sanitizeCommandOutput,
} from "./bootstrap-diagnostics.js";
import { FALLBACK_BOT_NAME, resolveBotName } from "./bot-name.js";
import { githubCredentials } from "./credentials.js";
import { brokerPolicy, mintInstallationToken, REMOTE_URL } from "./git-remote.js";

// Snapshot settings shared by every factory sandbox. One kept snapshot keeps
// storage flat across template rebuilds; the 14-day expiration (Vercel removes
// unresumable sandboxes after 14 days anyway) stops a quiet stretch from
// expiring the template and making the next session queue behind a full
// clone-and-setup rebuild.
export const FACTORY_SANDBOX_CREATE_OPTIONS = {
  keepLastSnapshots: { count: 1, deleteEvicted: true },
  resources: { vcpus: 4 },
  snapshotExpiration: 14 * 24 * 60 * 60 * 1000,
} satisfies VercelSandboxCreateOptions;

/**
 * Runs a command in the sandbox and throws on a nonzero exit, so a broken
 * clone or setup fails the template build loudly instead of shipping a
 * half-provisioned snapshot to every session.
 */
async function runOrThrow(sandbox: SandboxSession, command: string): Promise<void> {
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0) {
    throw new Error(
      sanitizeCommandOutput(
        `Sandbox command failed (exit ${result.exitCode}): ${command}\n${String(
          result.stderr || result.stdout,
        ).trim()}`,
      ),
    );
  }
}

// Mints the brokered installation token, translating a refusal (typically
// "App authorization required" from Connect) into the actionable message.
// The original error rides along as the cause; the token itself never
// appears in either.
async function mintTokenOrExplain(mint: () => Promise<string>): Promise<string> {
  try {
    return await mint();
  } catch (error) {
    throw new Error(appAccessMessage(FACTORY_REPO), { cause: error });
  }
}

/**
 * Build-time revalidation key for the station sandboxes.
 *
 * @remarks
 * Changing the target repository or its setup command rebuilds the template;
 * authored sandbox source is tracked by eve automatically.
 */
export function factoryRevalidationKey(): string {
  return `factory-repo-v1:${FACTORY_REPO}:${process.env.FACTORY_SETUP_COMMAND ?? ""}`;
}

/**
 * Template-scoped bootstrap shared by the analyst, implementer, and reviewer
 * sandboxes: clone the factory repository and run its setup command.
 *
 * @remarks
 * - Runs once per template build, so the clone and dependency install are
 *   paid once and every session inherits the filesystem.
 * - The clone authenticates through the sandbox firewall (the installation
 *   token is injected as a header transform and never enters the sandbox),
 *   which works for private and public repositories alike.
 * - `FACTORY_SETUP_COMMAND` (e.g. `pnpm install`) runs inside the checkout
 *   when set; a failure fails the template build, not a session.
 * - The bot's git identity is deliberately not set here: config written at
 *   template build lands in the builder's home directory, which is not
 *   guaranteed to be the session user's, so it belongs in
 *   {@link factoryOnSession}.
 * - Failures are translated into messages that name `FACTORY_REPO` and the
 *   fix (see `bootstrap-diagnostics.ts`), keep the original error as the
 *   cause, and never carry the token.
 */
export async function factoryBootstrap({ use }: SandboxBootstrapContext): Promise<void> {
  const sandbox = await use();
  const token = await mintTokenOrExplain(() => mintInstallationToken(githubCredentials));
  await sandbox.setNetworkPolicy(brokerPolicy(token));
  try {
    try {
      await runOrThrow(sandbox, `git clone --depth 50 ${REMOTE_URL} repo`);
    } catch (error) {
      throw new Error(describeCloneFailure(FACTORY_REPO, safeErrorMessage(error)), {
        cause: error,
      });
    }
    const setup = process.env.FACTORY_SETUP_COMMAND;
    if (setup) {
      await runOrThrow(sandbox, `cd repo && ${setup}`);
    }
  } finally {
    await sandbox.setNetworkPolicy("allow-all");
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
 * Session-scoped setup shared by the station sandboxes: fix git's ownership
 * check and move the checkout to the repository's current default branch.
 *
 * @remarks
 * - The template snapshot is owned by the builder uid, not the session user;
 *   without the `safe.directory` entries every git command dies on "dubious
 *   ownership". The commit identity is written here for the same reason:
 *   session-scoped config lands in the session user's own home directory,
 *   where the implementer's commits actually read it.
 * - The default branch is read from the clone's `origin/HEAD` rather than
 *   assumed, so repositories whose default is not `main` work unchanged.
 * - The fetch targets {@link REMOTE_URL} literally with a firewall-brokered
 *   credential, mirroring the bootstrap clone.
 */
export async function factoryOnSession({ use }: SandboxSessionContext): Promise<void> {
  const sandbox = await use();
  const identity = await gitIdentity();
  await runOrThrow(
    sandbox,
    `git config --global --add safe.directory /workspace && git config --global --add safe.directory /workspace/repo && git config --global user.name "${identity.name}" && git config --global user.email "${identity.email}"`,
  );
  const token = await mintTokenOrExplain(() => mintInstallationToken(githubCredentials));
  await sandbox.setNetworkPolicy(brokerPolicy(token));
  try {
    await runOrThrow(
      sandbox,
      `cd repo && branch=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||') && git fetch ${REMOTE_URL} "$branch" && git checkout -B "$branch" FETCH_HEAD`,
    );
  } finally {
    await sandbox.setNetworkPolicy("allow-all");
  }
}
