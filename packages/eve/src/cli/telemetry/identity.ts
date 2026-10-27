import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { readVercelCliTeam } from "#internal/model-auth/vercel-cli.js";

const runFile = promisify(execFile);
const GIT_TIMEOUT_MS = 1_000;

/**
 * Fingerprints of Vercel-internal team IDs, from {@link fingerprintVercelTeam}.
 * Only these one-way fingerprints ship in eve, never the team IDs themselves.
 */
const INTERNAL_TEAM_FINGERPRINTS: ReadonlySet<string> = new Set<string>([]);

export type EveCliTelemetryIdentity = {
  readonly installationId: string;
  readonly projectSalt: string;
};

export function createEveTelemetryIdentity(): EveCliTelemetryIdentity {
  return { installationId: randomUUID(), projectSalt: randomUUID() };
}

export function isEphemeralEveTelemetryEnvironment(): boolean {
  return Boolean(process.env.CI) || existsSync("/.dockerenv");
}

export function hashEveTelemetryProject(identity: EveCliTelemetryIdentity, value: string): string {
  return createHash("sha256").update(identity.projectSalt).update(value).digest("hex");
}

export function fingerprintVercelTeam(teamId: string): string {
  return createHash("sha256").update("eve-telemetry-team:").update(teamId).digest("hex");
}

/**
 * Whether the Vercel CLI's selected team is a Vercel-internal team, read from local CLI
 * config without a network call. Undefined when there is no fingerprint list to compare with.
 */
export async function resolveEveTelemetryInternal(
  input: {
    readonly fingerprints?: ReadonlySet<string>;
    readonly readTeam?: () => Promise<string | undefined>;
  } = {},
): Promise<boolean | undefined> {
  const fingerprints = input.fingerprints ?? INTERNAL_TEAM_FINGERPRINTS;
  if (fingerprints.size === 0) return undefined;
  const teamId = await (input.readTeam ?? readVercelCliTeam)();
  return teamId !== undefined && fingerprints.has(fingerprintVercelTeam(teamId));
}

export async function resolveEveTelemetryProjectId(input: {
  readonly cwd?: string;
  readonly repositoryUrl?: string;
  readonly getGitRemote?: (cwd: string) => Promise<string | undefined>;
  readonly identity: EveCliTelemetryIdentity;
}): Promise<string> {
  const cwd = input.cwd ?? process.cwd();
  const gitRemote = await (input.getGitRemote ?? getGitRemote)(cwd);
  return hashEveTelemetryProject(
    input.identity,
    gitRemote ?? input.repositoryUrl ?? process.env.REPOSITORY_URL ?? cwd,
  );
}

async function getGitRemote(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await runFile("git", ["config", "--local", "--get", "remote.origin.url"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    const value = stdout.trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}
