import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { hasEnvValue } from "#internal/resolve-model-endpoint-status.js";
import { isObject } from "#shared/guards.js";
import { AI_GATEWAY_API_KEY_ENV_VAR } from "#setup/ai-gateway-api-key.js";
import { findEnvFileWithKey } from "#setup/boxes/detect-ai-gateway.js";
import { readProjectLink } from "#setup/project-resolution.js";

const PROVIDER_SELECTIONS = ["chatgpt", "ai-gateway-key", "ai-gateway-project"] as const;

export type ProviderSelection = (typeof PROVIDER_SELECTIONS)[number];

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

export async function writeProviderSelection(
  appRoot: string,
  selected: ProviderSelection,
): Promise<void> {
  await mkdir(join(appRoot, ".eve"), { recursive: true });
  await writeFile(
    providerSettingsPath(appRoot),
    `${JSON.stringify({ selected }, null, 2)}\n`,
    "utf8",
  );
}

function parseProviderSelection(value: unknown): ProviderSelection | undefined {
  return isObject(value) && isProviderSelection(value.selected) ? value.selected : undefined;
}

function isProviderSelection(value: unknown): value is ProviderSelection {
  return PROVIDER_SELECTIONS.some((selection) => selection === value);
}
