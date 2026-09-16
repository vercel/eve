import semver from "#compiled/semver/index.js";
import { captureVercel } from "#setup/primitives/run-vercel.js";

const VERCEL_CLI_VERSION_PATTERN = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/u;

/** Read the version reported by the Vercel CLI resolved for one project. */
export async function detectVercelCliVersion(input: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<string | undefined> {
  const result = await captureVercel(["--version"], {
    cwd: input.projectRoot,
    nonInteractive: true,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
  const output = result.ok ? result.stdout : `${result.failure.stdout}\n${result.failure.stderr}`;
  const version = VERCEL_CLI_VERSION_PATTERN.exec(output)?.[0];
  return version === undefined || semver.validRange(version) === null ? undefined : version;
}

/** Whether one exact Vercel CLI version meets a minimum version. */
export function isVercelCliVersionSupported(version: string, minimumVersion: string): boolean {
  return semver.validRange(version) !== null && semver.subset(version, `>=${minimumVersion}`);
}
