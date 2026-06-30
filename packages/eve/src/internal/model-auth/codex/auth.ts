import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type CodexAuthMode = "api-key" | "chatgpt" | "unknown";

export type CodexAuthState =
  | {
      readonly kind: "authenticated";
      readonly accountId?: string;
      readonly authMode: CodexAuthMode;
      readonly authPath: string;
      readonly codexHome: string;
      readonly lastRefresh?: string;
    }
  | {
      readonly kind: "missing";
      readonly authPath: string;
      readonly codexHome: string;
    }
  | {
      readonly kind: "invalid";
      readonly authPath: string;
      readonly codexHome: string;
      readonly reason: string;
    };

export interface ReadCodexAuthStateOptions {
  readonly codexHome?: string;
}

export async function readCodexAuthState(
  options: ReadCodexAuthStateOptions = {},
): Promise<CodexAuthState> {
  const codexHome = options.codexHome ?? resolveDefaultCodexHome();
  const authPath = join(codexHome, "auth.json");

  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { kind: "missing", authPath, codexHome };
    }
    return {
      kind: "invalid",
      authPath,
      codexHome,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  return parseCodexAuthJson(raw, { authPath, codexHome });
}

export function parseCodexAuthJson(
  raw: string,
  input: {
    readonly authPath: string;
    readonly codexHome: string;
  },
): CodexAuthState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      kind: "invalid",
      authPath: input.authPath,
      codexHome: input.codexHome,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!isRecord(parsed)) {
    return {
      kind: "invalid",
      authPath: input.authPath,
      codexHome: input.codexHome,
      reason: "auth.json must contain a JSON object.",
    };
  }

  const authMode = parseAuthMode(parsed.auth_mode);
  const apiKey = typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim() !== "";
  const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
  const hasOAuthToken =
    tokens !== undefined &&
    (hasNonEmptyString(tokens.access_token) || hasNonEmptyString(tokens.refresh_token));

  if (!apiKey && !hasOAuthToken) {
    return {
      kind: "missing",
      authPath: input.authPath,
      codexHome: input.codexHome,
    };
  }

  const accountId =
    tokens !== undefined && typeof tokens.account_id === "string" && tokens.account_id.trim() !== ""
      ? tokens.account_id
      : undefined;
  const lastRefresh =
    typeof parsed.last_refresh === "string" && parsed.last_refresh.trim() !== ""
      ? parsed.last_refresh
      : undefined;

  return {
    kind: "authenticated",
    authMode: apiKey && !hasOAuthToken ? "api-key" : authMode,
    authPath: input.authPath,
    codexHome: input.codexHome,
    ...(accountId !== undefined && { accountId }),
    ...(lastRefresh !== undefined && { lastRefresh }),
  };
}

export function assertCodexAuthStateAuthenticated(state: CodexAuthState): void {
  if (state.kind === "authenticated") {
    return;
  }

  if (state.kind === "missing") {
    throw new Error(
      `Codex login state was not found at ${state.authPath}. Run \`codex login\` before using experimentalCodex.`,
    );
  }

  throw new Error(
    `Codex login state at ${state.authPath} could not be read: ${state.reason}. Run \`codex login\` again before using experimentalCodex.`,
  );
}

function resolveDefaultCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function parseAuthMode(value: unknown): CodexAuthMode {
  if (value === "chatgpt") return "chatgpt";
  if (value === "api-key") return "api-key";
  return "unknown";
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
