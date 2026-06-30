import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "#compiled/zod/index.js";

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

export interface CodexApiKeyCredentials {
  readonly apiKey: string;
  readonly authPath: string;
  readonly codexHome: string;
  readonly kind: "api-key";
}

export interface CodexChatGptCredentials {
  readonly accessToken?: string;
  readonly accountId?: string;
  readonly authPath: string;
  readonly codexHome: string;
  readonly idToken?: string;
  readonly kind: "chatgpt";
  readonly lastRefresh?: string;
  readonly refreshToken?: string;
}

export type CodexAuthCredentials = CodexApiKeyCredentials | CodexChatGptCredentials;

export interface CodexRefreshedTokens {
  readonly accessToken: string;
  readonly accountId?: string;
  readonly idToken?: string;
  readonly refreshToken: string;
}

const TOKEN_REFRESH_SKEW_MS = 60_000;

const codexAuthTokensSchema = z
  .object({
    access_token: z.string().nullable().optional(),
    account_id: z.string().nullable().optional(),
    id_token: z.string().nullable().optional(),
    refresh_token: z.string().nullable().optional(),
  })
  .passthrough();

const codexAuthFileSchema = z
  .object({
    OPENAI_API_KEY: z.string().nullable().optional(),
    auth_mode: z.string().nullable().optional(),
    last_refresh: z.string().nullable().optional(),
    tokens: codexAuthTokensSchema.nullable().optional(),
  })
  .passthrough();

type CodexAuthFile = z.infer<typeof codexAuthFileSchema>;
type ParsedCodexAuthFile =
  | { readonly kind: "parsed"; readonly value: CodexAuthFile }
  | { readonly kind: "invalid"; readonly reason: string };

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

export async function readCodexAuthCredentials(
  options: ReadCodexAuthStateOptions = {},
): Promise<CodexAuthCredentials> {
  const codexHome = options.codexHome ?? resolveDefaultCodexHome();
  const authPath = join(codexHome, "auth.json");

  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `Codex login state was not found at ${authPath}. Run \`codex login\` before using experimentalCodex.`,
      );
    }
    throw new Error(
      `Codex login state at ${authPath} could not be read: ${error instanceof Error ? error.message : String(error)}. Run \`codex login\` again before using experimentalCodex.`,
    );
  }

  return parseCodexAuthCredentialsJson(raw, { authPath, codexHome });
}

export function parseCodexAuthJson(
  raw: string,
  input: {
    readonly authPath: string;
    readonly codexHome: string;
  },
): CodexAuthState {
  const parsed = parseCodexAuthFile(raw);
  if (parsed.kind === "invalid") {
    return {
      kind: "invalid",
      authPath: input.authPath,
      codexHome: input.codexHome,
      reason: parsed.reason,
    };
  }

  const auth = parsed.value;
  const authMode = parseAuthMode(auth.auth_mode);
  const apiKey = hasNonEmptyString(auth.OPENAI_API_KEY);
  const tokens = auth.tokens ?? undefined;
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

  const accountId = readNonEmptyString(tokens?.account_id);
  const lastRefresh = readNonEmptyString(auth.last_refresh);

  return {
    kind: "authenticated",
    authMode: apiKey && !hasOAuthToken ? "api-key" : authMode,
    authPath: input.authPath,
    codexHome: input.codexHome,
    ...(accountId !== undefined && { accountId }),
    ...(lastRefresh !== undefined && { lastRefresh }),
  };
}

export function parseCodexAuthCredentialsJson(
  raw: string,
  input: {
    readonly authPath: string;
    readonly codexHome: string;
  },
): CodexAuthCredentials {
  const parsed = parseCodexAuthFile(raw);
  if (parsed.kind === "invalid") {
    throw new Error(
      `Codex login state at ${input.authPath} could not be read: ${parsed.reason}. Run \`codex login\` again before using experimentalCodex.`,
    );
  }

  const auth = parsed.value;
  const apiKey = readNonEmptyString(auth.OPENAI_API_KEY);
  const authMode = parseAuthMode(auth.auth_mode);
  const tokens = auth.tokens ?? undefined;
  const accessToken = readNonEmptyString(tokens?.access_token);
  const refreshToken = readNonEmptyString(tokens?.refresh_token);

  if (
    (authMode === "chatgpt" || accessToken !== undefined || refreshToken !== undefined) &&
    tokens !== undefined
  ) {
    const accountId =
      readNonEmptyString(tokens.account_id) ??
      extractCodexAccountIdFromToken(readNonEmptyString(tokens.id_token)) ??
      extractCodexAccountIdFromToken(accessToken);
    const lastRefresh = readNonEmptyString(auth.last_refresh);
    return {
      kind: "chatgpt",
      authPath: input.authPath,
      codexHome: input.codexHome,
      ...(accessToken !== undefined && { accessToken }),
      ...(accountId !== undefined && { accountId }),
      ...(readNonEmptyString(tokens.id_token) !== undefined && {
        idToken: readNonEmptyString(tokens.id_token),
      }),
      ...(lastRefresh !== undefined && { lastRefresh }),
      ...(refreshToken !== undefined && { refreshToken }),
    };
  }

  if (apiKey !== undefined) {
    return {
      kind: "api-key",
      apiKey,
      authPath: input.authPath,
      codexHome: input.codexHome,
    };
  }

  throw new Error(
    `Codex login state was not found at ${input.authPath}. Run \`codex login\` before using experimentalCodex.`,
  );
}

function parseCodexAuthFile(raw: string): ParsedCodexAuthFile {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }

  const parsed = codexAuthFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return { kind: "invalid", reason: "auth.json must match the Codex auth schema." };
  }

  return { kind: "parsed", value: parsed.data };
}

export async function writeCodexAuthCredentials(input: {
  readonly credentials: CodexChatGptCredentials;
  readonly now?: () => Date;
  readonly tokens: CodexRefreshedTokens;
}): Promise<CodexChatGptCredentials> {
  const raw = await readFile(input.credentials.authPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(
      `Codex login state at ${input.credentials.authPath} must contain a JSON object.`,
    );
  }

  const existingTokens = isRecord(parsed.tokens) ? parsed.tokens : {};
  const accountId =
    input.tokens.accountId ??
    input.credentials.accountId ??
    extractCodexAccountIdFromToken(input.tokens.idToken) ??
    extractCodexAccountIdFromToken(input.tokens.accessToken);
  const idToken = input.tokens.idToken ?? input.credentials.idToken;
  const lastRefresh = (input.now ?? (() => new Date()))().toISOString();
  const next = {
    ...parsed,
    auth_mode: "chatgpt",
    tokens: {
      ...existingTokens,
      access_token: input.tokens.accessToken,
      refresh_token: input.tokens.refreshToken,
      ...(accountId !== undefined && { account_id: accountId }),
      ...(idToken !== undefined && { id_token: idToken }),
    },
    last_refresh: lastRefresh,
  };

  await writeFile(input.credentials.authPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  return {
    kind: "chatgpt",
    accessToken: input.tokens.accessToken,
    authPath: input.credentials.authPath,
    codexHome: input.credentials.codexHome,
    lastRefresh,
    refreshToken: input.tokens.refreshToken,
    ...(accountId !== undefined && { accountId }),
    ...(idToken !== undefined && { idToken }),
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

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CodexJwtClaims {
  readonly chatgpt_account_id?: string;
  readonly organizations?: readonly { readonly id?: unknown }[];
  readonly "https://api.openai.com/auth"?: {
    readonly chatgpt_account_id?: string;
  };
}

export function readCodexJwtExpirationMs(token: string | undefined): number | undefined {
  const claims = parseCodexJwtClaims(token);
  if (!isRecord(claims) || typeof claims.exp !== "number") return undefined;
  return claims.exp * 1000;
}

export function isFreshCodexAccessToken(accessToken: string | undefined, now: number): boolean {
  if (accessToken === undefined) return false;
  const expiresAt = readCodexJwtExpirationMs(accessToken);
  return expiresAt === undefined || expiresAt - TOKEN_REFRESH_SKEW_MS > now;
}

export function extractCodexAccountIdFromToken(token: string | undefined): string | undefined {
  const claims = parseCodexJwtClaims(token);
  if (claims === undefined) return undefined;
  return (
    readNonEmptyString(claims.chatgpt_account_id) ??
    readNonEmptyString(claims["https://api.openai.com/auth"]?.chatgpt_account_id) ??
    readNonEmptyString(claims.organizations?.[0]?.id)
  );
}

function parseCodexJwtClaims(
  token: string | undefined,
): (CodexJwtClaims & { readonly exp?: unknown }) | undefined {
  if (token === undefined) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
