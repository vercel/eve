import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isObject } from "#shared/guards.js";
import { isModelConnection, type ModelConnectionSelection } from "#shared/model-connection.js";

export interface ProviderSettings {
  selected: ModelConnectionSelection;
  teamId?: string;
  teamName?: string;
  keySource?: "environment" | "secret";
}

export function providerSettingsPath(appRoot: string): string {
  return join(appRoot, ".eve", "provider.json");
}

export function isProviderSelection(value: unknown): value is ModelConnectionSelection {
  return isModelConnection(value) || value === "vercel-cli" || value === "ai-gateway-project";
}

export function readProviderSettingsSync(appRoot: string): ProviderSettings | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(providerSettingsPath(appRoot), "utf8"));
    if (!isObject(value) || !isProviderSelection(value.selected)) return undefined;
    return {
      selected: value.selected,
      ...(typeof value.teamId === "string" &&
        typeof value.teamName === "string" && { teamId: value.teamId, teamName: value.teamName }),
      ...((value.keySource === "environment" || value.keySource === "secret") && {
        keySource: value.keySource,
      }),
    };
  } catch {
    return undefined;
  }
}
