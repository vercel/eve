import { isModelConnection, type ModelConnectionSelection } from "#shared/model-connection.js";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { hasEnvValue } from "#internal/resolve-model-endpoint-status.js";
import { isObject } from "#shared/guards.js";
import { AI_GATEWAY_API_KEY_ENV_VAR } from "#setup/ai-gateway-api-key.js";
import { findEnvFileWithKey } from "#setup/boxes/detect-ai-gateway.js";
import { readProjectLink } from "#setup/project-resolution.js";

const PROVIDER_SELECTIONS = ["chatgpt", "ai-gateway-key", "ai-gateway-project"] as const;

export type ProviderSelection = ModelConnectionSelection;

export function providerSettingsPath(appRoot: string): string {
  return join(appRoot, ".eve", "provider.json");
}

export async function resolveAvailableProviders(
  appRoot: string,
  options: {
    signal?: AbortSignal;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<readonly ProviderSelection[]> {
  const { signal, env = process.env } = options;
  signal?.throwIfAborted();
  const [projectLink, gatewayKeyFile, oidcFile] = await Promise.all([
    readProjectLink(appRoot),
    findEnvFileWithKey(appRoot, AI_GATEWAY_API_KEY_ENV_VAR),
    findEnvFileWithKey(appRoot, "VERCEL_OIDC_TOKEN"),
  ]);
  signal?.throwIfAborted();
  const available: ProviderSelection[] = ["chatgpt"];

  if (gatewayKeyFile !== undefined || hasEnvValue(env[AI_GATEWAY_API_KEY_ENV_VAR])) {
    available.push("ai-gateway-key");
  }

  if (projectLink !== undefined || oidcFile !== undefined) {
    available.push("ai-gateway-project");
  }

  return available;
}

export async function readProviderSelection(
  appRoot: string,
): Promise<ProviderSelection | undefined> {
  try {
    return parseProviderSelection(
      JSON.parse(await readFile(providerSettingsPath(appRoot), "utf8")),
    );
  } catch {
    return undefined;
  }
}

/** Synchronous counterpart for the synchronous dev-environment loader. */
export function readProviderSelectionSync(appRoot: string): ProviderSelection | undefined {
  try {
    return parseProviderSelection(JSON.parse(readFileSync(providerSettingsPath(appRoot), "utf8")));
  } catch {
    return undefined;
  }
}

export interface ProviderSettings {
  selected: ProviderSelection;
  teamId?: string;
  teamName?: string;
  keySource?: "environment" | "secret";
}

export async function providerSettingsMatch(
  appRoot: string,
  settings: ProviderSettings,
): Promise<boolean> {
  try {
    const current = JSON.parse(await readFile(providerSettingsPath(appRoot), "utf8"));
    return (
      isObject(current) &&
      current.selected === settings.selected &&
      current.teamId === settings.teamId &&
      current.teamName === settings.teamName &&
      current.keySource === settings.keySource
    );
  } catch {
    return false;
  }
}

export async function writeProviderSelection(
  appRoot: string,
  selected: ProviderSelection,
  team?: { teamId: string; teamName: string },
  keySource?: "environment" | "secret",
): Promise<void> {
  await mkdir(join(appRoot, ".eve"), { recursive: true });
  await writeFile(
    providerSettingsPath(appRoot),
    `${JSON.stringify({ selected, ...team, keySource }, null, 2)}\n`,
    "utf8",
  );
}

function parseProviderSelection(value: unknown): ProviderSelection | undefined {
  return isObject(value) && isProviderSelection(value.selected) ? value.selected : undefined;
}

function isProviderSelection(value: unknown): value is ProviderSelection {
  return (
    isModelConnection(value) ||
    value === "vercel-cli" ||
    PROVIDER_SELECTIONS.some((selection) => selection === value)
  );
}

export function readProviderTeamSync(
  appRoot: string,
): { teamId: string; teamName: string } | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(providerSettingsPath(appRoot), "utf8"));
    if (isObject(value) && typeof value.teamId === "string" && typeof value.teamName === "string")
      return { teamId: value.teamId, teamName: value.teamName };
  } catch {
    /* No team has been selected for this project. */
  }
  return undefined;
}

export function readProviderKeySourceSync(appRoot: string): "environment" | "secret" | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(providerSettingsPath(appRoot), "utf8"));
    if (isObject(value) && (value.keySource === "environment" || value.keySource === "secret"))
      return value.keySource;
  } catch {}
  return undefined;
}
