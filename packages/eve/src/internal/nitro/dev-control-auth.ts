import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { timingSafeEqualStrings } from "#internal/nitro/dev-client-address.js";
import { isLoopbackServerUrl } from "#shared/network-address.js";

export const DEVELOPMENT_CONTROL_TOKEN_HEADER = "x-eve-dev-control-token";

const DEVELOPMENT_CONTROL_STATE_DIRECTORY_NAME = "eve-dev-control";
const developmentControlTokens = new Map<string, string>();

export function getOrCreateDevelopmentControlToken(appRoot: string): string {
  const existing = developmentControlTokens.get(appRoot);
  if (existing !== undefined) {
    return existing;
  }

  const token = randomBytes(32).toString("base64url");
  developmentControlTokens.set(appRoot, token);
  return token;
}

export function digestDevelopmentControlToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export async function persistDevelopmentControlToken(
  appRoot: string,
  token: string,
): Promise<void> {
  const stateDirectory = join(tmpdir(), DEVELOPMENT_CONTROL_STATE_DIRECTORY_NAME);
  const statePath = await resolveDevelopmentControlTokenPath(appRoot);
  await mkdir(stateDirectory, { mode: 0o700, recursive: true });
  await chmod(stateDirectory, 0o700);
  try {
    await chmod(statePath, 0o600);
  } catch (error) {
    if (!isErrnoException(error, "ENOENT")) {
      throw error;
    }
  }
  await writeFile(statePath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readDevelopmentControlToken(input: {
  readonly appRoot: string;
  readonly serverUrl: string;
}): Promise<string | undefined> {
  if (!isLoopbackServerUrl(input.serverUrl)) {
    return undefined;
  }

  try {
    const token = (
      await readFile(await resolveDevelopmentControlTokenPath(input.appRoot), "utf8")
    ).trim();
    return token.length >= 32 ? token : undefined;
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export function hasValidDevelopmentControlToken(headers: Headers, expectedDigest: string): boolean {
  const token = headers.get(DEVELOPMENT_CONTROL_TOKEN_HEADER);
  if (token === null || token.length === 0) {
    return false;
  }

  return timingSafeEqualStrings(digestDevelopmentControlToken(token), expectedDigest);
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function resolveDevelopmentControlTokenPath(appRoot: string): Promise<string> {
  const canonicalAppRoot = await realpath(appRoot);
  const appRootDigest = createHash("sha256").update(canonicalAppRoot).digest("base64url");
  return join(tmpdir(), DEVELOPMENT_CONTROL_STATE_DIRECTORY_NAME, `${appRootDigest}.token`);
}
