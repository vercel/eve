/**
 * Builds a syntactically valid, unsigned Vercel OIDC token for tests.
 * eve only ever reads payload claims and never verifies signatures, so
 * a fixed header and a literal signature segment suffice.
 */
export function createFakeVercelOidcToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}
