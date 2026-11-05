import { board } from "@vercel/board";
import { oidcTokens, vercelProject } from "@vercel/board/access";
import { a2 } from "@vercel/board/backend-a2";
import { memory } from "@vercel/board/backend-a2/store-memory";
import { type CryptoKey, generateKeyPair, SignJWT } from "jose";

const VERCEL_ISSUER = "https://oidc.vercel.com/acme";
const LOCAL_ISSUER = "https://board.local";

/** A real `@vercel/board` in memory, with an issuer that signs tokens it trusts. */
export interface TestBoard {
  readonly url: string;
  /** The board's HTTP handler: a `fetch` that never leaves the process. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** A token for the eve project `prj_eve`'s deployment in `environment`. */
  eveToken(environment?: string): Promise<string>;
  /** A token for a person, who acts as `local:user:<name>`. */
  personToken(name: string): Promise<string>;
}

/** Starts a board that lets the eve project `prj_eve`'s production deployment do everything. */
export function createTestBoard(url = "https://board.example.com/api/board"): TestBoard {
  const keys = generateKeyPair("RS256");
  const sign = async (issuer: string, claims: Record<string, unknown>) =>
    await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(issuer)
      .setAudience(url)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign((await keys).privateKey);
  const jwks = async (): Promise<CryptoKey> => (await keys).publicKey;

  const team = board({
    access: [vercelProject({ can: "all", environments: ["production"], project: "prj_eve" })],
    authenticate: oidcTokens({
      local: { issuer: LOCAL_ISSUER, jwks },
      vercel: { issuer: VERCEL_ISSUER, jwks },
    }),
    backend: a2({ store: memory() }),
    project: { id: "prj_board" },
    url,
  });

  return {
    url,
    fetch: (request) => team.fetch(request),
    eveToken: (environment = "production") =>
      sign(VERCEL_ISSUER, {
        environment,
        owner_id: "team_acme",
        project: "eve",
        project_id: "prj_eve",
        sub: `owner:acme:project:eve:environment:${environment}`,
      }),
    personToken: (name) => sign(LOCAL_ISSUER, { sub: name }),
  };
}
