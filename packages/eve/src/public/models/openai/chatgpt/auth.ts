import { decodeJwt } from "#compiled/jose/index.js";
import { isObject } from "#shared/guards.js";

export function readCodexJwtExpirationMs(token: string | undefined): number | undefined {
  const claims = parseCodexJwtClaims(token);
  if (claims === undefined || typeof claims.exp !== "number") return undefined;
  return claims.exp * 1000;
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

/** Human-readable account label from Codex's JWT, without retaining the token. */
export function extractCodexAccountLabelFromToken(token: string | undefined): string | undefined {
  const claims = parseCodexJwtClaims(token);
  if (claims === undefined) return undefined;
  const authClaims = claims["https://api.openai.com/auth"];
  const explicit =
    readEmail(claims.email) ?? readEmail(isObject(authClaims) ? authClaims.email : undefined);
  if (explicit !== undefined) return explicit;

  const subject = readNonEmptyString(claims.sub);
  return subject === undefined ? undefined : readEmail(subject.split("|").at(-1));
}

function readEmail(value: unknown): string | undefined {
  const candidate = readNonEmptyString(value);
  return candidate !== undefined && /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(candidate)
    ? candidate
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseCodexJwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  if (token === undefined) return undefined;
  try {
    return decodeJwt(token);
  } catch {
    return undefined;
  }
}
