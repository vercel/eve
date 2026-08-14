import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isObject } from "#shared/guards.js";

export type GatewayCredentialPreference = "project" | "api-key";

export function gatewayCredentialPreferencePath(appRoot: string): string {
  return join(appRoot, ".eve", "gateway-credential.json");
}

export async function readGatewayCredentialPreference(
  appRoot: string,
): Promise<GatewayCredentialPreference | undefined> {
  try {
    return parseGatewayCredentialPreference(
      JSON.parse(await readFile(gatewayCredentialPreferencePath(appRoot), "utf8")),
    );
  } catch {
    return undefined;
  }
}

/** Synchronous counterpart for the synchronous dev-environment loader. */
export function readGatewayCredentialPreferenceSync(
  appRoot: string,
): GatewayCredentialPreference | undefined {
  try {
    return parseGatewayCredentialPreference(
      JSON.parse(readFileSync(gatewayCredentialPreferencePath(appRoot), "utf8")),
    );
  } catch {
    return undefined;
  }
}

export async function writeGatewayCredentialPreference(
  appRoot: string,
  preferred: GatewayCredentialPreference,
): Promise<void> {
  const path = gatewayCredentialPreferencePath(appRoot);
  await mkdir(join(appRoot, ".eve"), { recursive: true });
  await writeFile(path, `${JSON.stringify({ preferred }, null, 2)}\n`, "utf8");
}

function parseGatewayCredentialPreference(value: unknown): GatewayCredentialPreference | undefined {
  return isObject(value) && isGatewayCredentialPreference(value.preferred)
    ? value.preferred
    : undefined;
}

function isGatewayCredentialPreference(value: unknown): value is GatewayCredentialPreference {
  return value === "project" || value === "api-key";
}
