import { createHmac } from "node:crypto";

/** Login role the deploy step creates and the agent connects as when it derives its connection. */
export const DERIVED_LOGIN = "eve_analyst";

/** Schema the demo data lives in. */
export const DEMO_SCHEMA = "analytics";

const NEEDS_PASSWORD =
  "needs a password to derive the read-only login. Include it in the URL, or set ANALYST_DATABASE_URL yourself.";
const INVALID_URL = "isn't a valid connection string.";

/**
 * Derives the read-only login's password from the owner's password.
 *
 * @param ownerUrl - `DATABASE_URL`, the connection that can create schemas and roles.
 * @returns A stable, URL-safe password that depends only on the owner's password, so changes to the host, port, database, or query options don't change it.
 * @throws {@link TypeError} When `ownerUrl` isn't a valid URL.
 * @throws {@link URIError} When the password's percent-encoding is malformed.
 * @throws {@link Error} When `ownerUrl` has no password, because the result would then be computable from details that aren't secret.
 * @remarks The deploy step sets this password on the login and the agent computes it again at runtime, so neither has to hand a secret to the other. Rotating the owner password changes it, and the next deploy updates the login to match.
 */
export const derivePassword = (ownerUrl: string): string => {
  const secret = decodeURIComponent(new URL(ownerUrl).password);
  if (!secret) {
    throw new Error(`DATABASE_URL ${NEEDS_PASSWORD}`);
  }
  return createHmac("sha256", secret)
    .update("eve-data-analyst login v2")
    .digest("base64url");
};

/** Options for {@link loginUrl}. */
interface LoginUrlOptions {
  /** Keep the owner's `.suffix` on the login's user name, for connection poolers that route by it. Defaults to true. */
  readonly keepUserSuffix?: boolean;
}

/**
 * Builds a login's connection string from the owner connection string.
 *
 * @param ownerUrl - `DATABASE_URL`.
 * @param login - Login role name, such as `eve_analyst`.
 * @param password - The login's password.
 * @param options - Whether to keep the owner's user name suffix.
 * @returns The same host, database, and options with the login's user name and password.
 * @throws {@link TypeError} When `ownerUrl` isn't a valid URL.
 * @remarks Connection poolers that encode a project in the user name, such as `postgres.<project-id>`, need that suffix, so it's kept by default. Pass `keepUserSuffix: false` when the owner's own user name contains a dot.
 */
export const loginUrl = (
  ownerUrl: string,
  login: string,
  password: string,
  { keepUserSuffix = true }: LoginUrlOptions = {}
): string => {
  const url = new URL(ownerUrl);
  const user = decodeURIComponent(url.username);
  const dot = user.indexOf(".");
  const suffix = keepUserSuffix && dot !== -1 ? user.slice(dot) : "";
  url.username = encodeURIComponent(`${login}${suffix}`);
  url.password = encodeURIComponent(password);
  return url.toString();
};

/**
 * Builds the derived read-only login's connection string from the owner connection string.
 *
 * @param ownerUrl - `DATABASE_URL`.
 * @returns The same host, database, and options with the read-only login's user and derived password.
 * @throws {@link TypeError} When `ownerUrl` isn't a valid URL.
 * @throws {@link Error} When `ownerUrl` has no password.
 * @remarks Keeps a connection pooler's user name suffix, as {@link loginUrl} does by default.
 */
export const deriveAnalystUrl = (ownerUrl: string): string =>
  loginUrl(ownerUrl, DERIVED_LOGIN, derivePassword(ownerUrl));

/**
 * Explains why the read-only login can't be derived from an owner connection string.
 *
 * @param ownerUrl - `DATABASE_URL`.
 * @returns Null when {@link deriveAnalystUrl} succeeds, or the reason it fails, phrased to follow the words "DATABASE_URL".
 * @remarks The reason never includes the URL, so it's safe to log.
 */
export const derivedLoginProblem = (ownerUrl: string): string | null => {
  try {
    deriveAnalystUrl(ownerUrl);
    return null;
  } catch {
    try {
      return new URL(ownerUrl).password ? INVALID_URL : NEEDS_PASSWORD;
    } catch {
      return INVALID_URL;
    }
  }
};

/**
 * Reads the decoded user name from a connection string.
 *
 * @param ownerUrl - `DATABASE_URL`.
 * @returns The user name, such as `postgres.<project-id>`, or an empty string when the URL has none.
 * @throws {@link TypeError} When `ownerUrl` isn't a valid URL.
 */
export const urlUser = (ownerUrl: string): string =>
  decodeURIComponent(new URL(ownerUrl).username);

/**
 * Reads a yes/no setting such as `ANALYST_SEED_DEMO_DATA`.
 *
 * @param value - Raw environment value.
 * @returns True for `1` or `true` in any case; false otherwise, including when unset.
 */
export const isEnabled = (value: string | undefined): boolean =>
  /^(?:1|true)$/iu.test(value?.trim() ?? "");
