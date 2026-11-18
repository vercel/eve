import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { AI_GATEWAY_API_KEY_ENV_FILE, AI_GATEWAY_API_KEY_ENV_VAR } from "../ai-gateway-api-key.js";
import {
  requireProjectPath,
  type AiGatewayEnvFile,
  type ResolvedAiGatewayCredentials,
  type SetupState,
} from "../state.js";
import type { SetupBox } from "../step.js";

const ENV_FILE_CANDIDATES = [
  AI_GATEWAY_API_KEY_ENV_FILE,
  ".env",
] as const satisfies readonly AiGatewayEnvFile[];

function readEnvValue(line: string, key: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return undefined;
  if (!trimmed.startsWith(`${key}=`)) return undefined;
  const raw = trimmed.slice(key.length + 1);
  if (raw.length === 0) return undefined;
  const unquoted =
    raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return unquoted.length === 0 ? undefined : unquoted;
}

async function hasApiKeyInFile(filePath: string, key: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return false;
  }
  for (const line of contents.split("\n")) {
    if (readEnvValue(line, key) !== undefined) return true;
  }
  return false;
}

export async function findEnvFileWithKey(
  projectRoot: string,
  key: string,
): Promise<AiGatewayEnvFile | undefined> {
  for (const fileName of ENV_FILE_CANDIDATES) {
    if (await hasApiKeyInFile(join(projectRoot, fileName), key)) {
      return fileName;
    }
  }
  return undefined;
}

export async function detectAiGatewayResolution(
  projectRoot: string,
): Promise<ResolvedAiGatewayCredentials> {
  const envFile = await findEnvFileWithKey(projectRoot, AI_GATEWAY_API_KEY_ENV_VAR);
  if (envFile !== undefined) {
    return { kind: "api-key", envFile };
  }
  return { kind: "unresolved" };
}

export function detectAiGateway(): SetupBox<SetupState, null, ResolvedAiGatewayCredentials> {
  return {
    id: "detect-ai-gateway",

    shouldRun(state) {
      return state.projectPath.kind === "resolved";
    },

    async gather(): Promise<null> {
      return null;
    },

    async perform({ state }): Promise<ResolvedAiGatewayCredentials> {
      return detectAiGatewayResolution(requireProjectPath(state));
    },

    apply(state, payload) {
      return { ...state, aiGatewayCredentials: payload };
    },
  };
}
