import { vercelOidc, withAuthChallenges, type VercelOidcOptions } from "#public/channels/auth.js";
import { areTokenClaimMatchersSatisfied } from "#channel/auth/token-claims.js";
import type { EveAuthFn } from "#eve-channel/types.js";

/** Vercel OIDC verification and eve-channel permissions for matched subjects. */
export interface EveVercelOidcOptions extends Omit<VercelOidcOptions, "subjects"> {
  /**
   * Additional subjects allowed to authenticate, with whole-string `*` matching.
   * Only an explicit grant on a matching entry permits service/runtime callers to use stubs.
   * String entries and implicit current-project acceptance grant ordinary access only.
   */
  readonly subjects?: readonly (
    | string
    | {
        readonly subject: string;
        readonly allowToolStubs?: boolean;
      }
  )[];
}

/**
 * Authenticates with Vercel OIDC and grants eve-channel permissions from matched subject entries.
 * User principals never receive subject-based grants. Declares the OIDC Bearer challenge.
 */
export function eveVercelOidc(opts: EveVercelOidcOptions = {}): EveAuthFn {
  const { subjects, ...verification } = opts;
  const authenticate = vercelOidc({
    ...verification,
    subjects: subjects?.map((entry) => (typeof entry === "string" ? entry : entry.subject)),
  });
  return withAuthChallenges(
    async (request) => {
      const caller = await authenticate(request);
      if (!caller) return null;
      const allowed =
        (caller.principalType === "service" || caller.principalType === "runtime") &&
        subjects?.some(
          (entry) =>
            typeof entry !== "string" &&
            entry.allowToolStubs === true &&
            areTokenClaimMatchersSatisfied({ sub: caller.subject }, { subjects: [entry.subject] }),
        );
      return allowed ? { ...caller, allowToolStubs: true } : caller;
    },
    [{ scheme: "Bearer" }],
  );
}
