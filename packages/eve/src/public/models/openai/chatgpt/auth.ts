import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { decodeJwt } from "#compiled/jose/index.js";
import { z } from "#compiled/zod/index.js";
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";

export type CodexAuthMode = "api-key" | "chatgpt";

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

/**
 * One read of the Codex login state: the reportable state view plus, when
 * authenticated, the credentials the transport uses. Both views derive from
 * the same parse and the same credential selection, so they cannot disagree.
 */
export interface CodexAuthSnapshot {
  readonly state: CodexAuthState;
  /** Set exactly when `state.kind` is `"authenticated"`. */
  readonly credentials?: CodexAuthCredentials;
}

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

export async function readCodexAuth(
  options: ReadCodexAuthStateOptions = {},
): Promise<CodexAuthSnapshot> {
  const codexHome = options.codexHome ?? resolveDefaultCodexHome();
  const authPath = join(codexHome, "auth.json");

  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { state: { kind: "missing", authPath, codexHome } };
    }
    return {
      state: { kind: "invalid", authPath, codexHome, reason: toErrorMessage(error) },
    };
  }

  return parseCodexAuth(raw, { authPath, codexHome });
}

export async function readCodexAuthCredentials(
  options: ReadCodexAuthStateOptions = {},
): Promise<CodexAuthCredentials> {
  const snapshot = await readCodexAuth(options);
  if (snapshot.credentials !== undefined) {
    return snapshot.credentials;
  }
  assertCodexAuthStateAuthenticated(snapshot.state);
  // Unreachable: parseCodexAuth pairs every authenticated state with credentials.
  throw new Error(
    `Codex login state at ${snapshot.state.authPath} did not include usable credentials.`,
  );
}

export function parseCodexAuth(
  raw: string,
  input: {
    readonly authPath: string;
    readonly codexHome: string;
  },
): CodexAuthSnapshot {
  const parsed = parseCodexAuthFile(raw);
  if (parsed.kind === "invalid") {
    return {
      state: {
        kind: "invalid",
        authPath: input.authPath,
        codexHome: input.codexHome,
        reason: parsed.reason,
      },
    };
  }

  const selection = selectCodexCredentials(parsed.value);
  if (selection.kind === "none") {
    return {
      state: { kind: "missing", authPath: input.authPath, codexHome: input.codexHome },
    };
  }

  if (selection.kind === "api-key") {
    return {
      state: {
        kind: "authenticated",
        authMode: "api-key",
        authPath: input.authPath,
        codexHome: input.codexHome,
      },
      credentials: {
        kind: "api-key",
        apiKey: selection.apiKey,
        authPath: input.authPath,
        codexHome: input.codexHome,
      },
    };
  }

  return {
    state: {
      kind: "authenticated",
      authMode: "chatgpt",
      authPath: input.authPath,
      codexHome: input.codexHome,
      ...(selection.accountId !== undefined && { accountId: selection.accountId }),
      ...(selection.lastRefresh !== undefined && { lastRefresh: selection.lastRefresh }),
    },
    credentials: {
      kind: "chatgpt",
      authPath: input.authPath,
      codexHome: input.codexHome,
      ...(selection.accessToken !== undefined && { accessToken: selection.accessToken }),
      ...(selection.accountId !== undefined && { accountId: selection.accountId }),
      ...(selection.idToken !== undefined && { idToken: selection.idToken }),
      ...(selection.lastRefresh !== undefined && { lastRefresh: selection.lastRefresh }),
      ...(selection.refreshToken !== undefined && { refreshToken: selection.refreshToken }),
    },
  };
}

type CodexCredentialSelection =
  | { readonly kind: "api-key"; readonly apiKey: string }
  | {
      readonly kind: "chatgpt";
      readonly accessToken?: string;
      readonly accountId?: string;
      readonly idToken?: string;
      readonly lastRefresh?: string;
      readonly refreshToken?: string;
    }
  | { readonly kind: "none" };

/**
 * Picks which credential in auth.json is active. An explicit `auth_mode`
 * wins when its credential is usable; otherwise the usable credential the
 * file actually carries wins, ChatGPT tokens first (they are the Codex CLI's
 * primary login). A `tokens` block with no usable token never outranks an
 * API key, and stale tokens never outrank an explicit `auth_mode: "api-key"`.
 */
function selectCodexCredentials(auth: CodexAuthFile): CodexCredentialSelection {
  const apiKey = readNonEmptyString(auth.OPENAI_API_KEY);
  const tokens = auth.tokens ?? undefined;
  const accessToken = readNonEmptyString(tokens?.access_token);
  const refreshToken = readNonEmptyString(tokens?.refresh_token);
  const hasUsableTokens = accessToken !== undefined || refreshToken !== undefined;
  const preferApiKey = auth.auth_mode === "api-key" && apiKey !== undefined;

  if (hasUsableTokens && !preferApiKey) {
    const accountId =
      readNonEmptyString(tokens?.account_id) ??
      extractCodexAccountIdFromToken(readNonEmptyString(tokens?.id_token)) ??
      extractCodexAccountIdFromToken(accessToken);
    const idToken = readNonEmptyString(tokens?.id_token);
    const lastRefresh = readNonEmptyString(auth.last_refresh);
    return {
      kind: "chatgpt",
      ...(accessToken !== undefined && { accessToken }),
      ...(accountId !== undefined && { accountId }),
      ...(idToken !== undefined && { idToken }),
      ...(lastRefresh !== undefined && { lastRefresh }),
      ...(refreshToken !== undefined && { refreshToken }),
    };
  }

  if (apiKey !== undefined) {
    return { kind: "api-key", apiKey };
  }

  return { kind: "none" };
}

function parseCodexAuthFile(raw: string): ParsedCodexAuthFile {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return { kind: "invalid", reason: toErrorMessage(error) };
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
  if (!isObject(parsed)) {
    throw new Error(
      `Codex login state at ${input.credentials.authPath} must contain a JSON object.`,
    );
  }

  const existingTokens = isObject(parsed.tokens) ? parsed.tokens : {};
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
      `Codex login state was not found at ${state.authPath}. Run \`codex login\` before using experimental_chatgpt.`,
    );
  }

  throw new Error(
    `Codex login state at ${state.authPath} could not be read: ${state.reason}. Run \`codex login\` again before using experimental_chatgpt.`,
  );
}

function resolveDefaultCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function readCodexJwtExpirationMs(token: string | undefined): number | undefined {
  const claims = parseCodexJwtClaims(token);
  if (claims === undefined || typeof claims.exp !== "number") return undefined;
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
  const authClaims = claims["https://api.openai.com/auth"];
  const organizations = claims.organizations;
  return (
    readNonEmptyString(claims.chatgpt_account_id) ??
    readNonEmptyString(isObject(authClaims) ? authClaims.chatgpt_account_id : undefined) ??
    readNonEmptyString(
      Array.isArray(organizations) && isObject(organizations[0]) ? organizations[0].id : undefined,
    )
  );
}

function parseCodexJwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  if (token === undefined) return undefined;
  try {
    return decodeJwt(token);
  } catch {
    return undefined;
  }
}
