import {
  decodeUnverifiedJwtClaims,
  extractBearerToken,
  runOidcVerification,
  withAuthChallenges,
  type AuthFn,
  type VerifyResult,
} from "#channel/auth/definitions.js";
import {
  createRuntimeSessionAuthContext,
  type ResolvedOidcAuthStrategy,
} from "#channel/auth/types.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { createLogger } from "#internal/logging.js";
import { vercelDeployment } from "#platform/vercel/deployment.js";
import { vercelCurrentProject } from "#platform/vercel/identity.js";
import { resolveVercelOidcCurrentProject } from "#platform/vercel/oidc-project.js";
import { isVercelOidcIssuer } from "#platform/vercel/project.js";

const vercelOidcLog = createLogger("auth.vercel-oidc");

const VERCEL_OIDC_AUDIENCE_PREFIX = "https://vercel.com/";

/**
 * Options for verifying a Vercel OIDC token with {@link verifyVercelOidc}.
 */
export interface VerifyVercelOidcOptions {
  /**
   * Explicit current-project binding for the verified token. When omitted,
   * the verifier reads `VERCEL_PROJECT_ID` and `VERCEL_TARGET_ENV` /
   * `VERCEL_ENV` from the runtime environment.
   */
  readonly currentVercelProject?: {
    readonly environment?: string;
    readonly projectId: string;
  };
  /**
   * Optional `sub` patterns granting callers access on top of the always-on
   * current-project bypass. Patterns use AWS IAM-style `*` wildcards and may
   * target tokens minted by other Vercel projects (e.g.
   * `"owner:acme:project:partner-agent:environment:*"`). The current project
   * is always accepted regardless of this list.
   */
  readonly subjects?: readonly string[];
}

/**
 * Verifies a bearer JWT minted by Vercel OIDC.
 *
 * Acceptance rule:
 *
 * - Current-project tokens that reach the service/runtime path are accepted
 *   regardless of `subjects`, so the deployment's own runtime callers
 *   (subagent, internal fetches) authenticate without being enumerated.
 * - Tokens with an `external_sub` claim authenticate as
 *   `principalType: "user"` when they match the configured current project
 *   and environment. `external_sub`
 *   becomes the eve subject, `external_iss` or `connector_id` the eve issuer
 *   when present, and string-valued OIDC profile claims (`name`, `picture`,
 *   `email`) are exposed as auth attributes.
 * - Development tokens with a `user_id` claim authenticate as
 *   `principalType: "user"` only when both the token and configured current
 *   project environment are `development`. Other same-project target
 *   environments may use one as a `"service"` principal.
 * - Tokens from other Vercel projects are accepted **only** when their `sub`
 *   matches one of {@link VerifyVercelOidcOptions.subjects}.
 *
 * Tokens without a `user_id` claim are accepted for the current project in
 * production, preview, and development. They are tagged `"runtime"` when the
 * token's `environment` matches the current deployment, otherwise `"service"`.
 */
export async function verifyVercelOidc(
  token: string | null,
  opts: VerifyVercelOidcOptions = {},
): Promise<VerifyResult> {
  if (token === null || token.length === 0) {
    return { ok: false };
  }

  const claims = decodeUnverifiedJwtClaims(token);
  if (claims === null) {
    vercelOidcLog.debug("Rejected token that failed to decode as a JWT.");
    return { ok: false };
  }

  if (!isVercelOidcIssuer(claims.issuer)) {
    vercelOidcLog.debug("Rejected token whose issuer is not a Vercel OIDC issuer.", {
      issuer: claims.issuer,
    });
    return { ok: false };
  }

  if (claims.audiences.length === 0) {
    vercelOidcLog.debug("Rejected token with no audience claim.", { issuer: claims.issuer });
    return { ok: false };
  }

  if (!claims.audiences.some((audience) => audience.startsWith(VERCEL_OIDC_AUDIENCE_PREFIX))) {
    vercelOidcLog.debug("Rejected token whose audience is not a Vercel audience.", {
      audiences: claims.audiences,
      issuer: claims.issuer,
    });
    return { ok: false };
  }

  const currentVercelProject = resolveCurrentVercelProject(opts);
  const result = await runOidcVerification(token, {
    acceptCurrentVercelProject: true,
    audiences: claims.audiences,
    currentVercelProject,
    issuer: claims.issuer,
    subjects: opts.subjects ?? [],
  });

  if (result.kind === "authenticated") {
    vercelOidcLog.debug("Accepted Vercel OIDC token.", {
      issuer: claims.issuer,
      principalType: result.principal.principalType,
      subject: result.principal.subject,
    });
    return { ok: true, sessionAuth: createRuntimeSessionAuthContext(result.principal) };
  }

  vercelOidcLog.debug("Rejected Vercel OIDC token after verification.", {
    audiences: claims.audiences,
    issuer: claims.issuer,
    reason: result.kind,
    subjectsConfigured: (opts.subjects ?? []).length > 0,
    detail: result.kind === "misconfigured" ? result.message : undefined,
  });
  return { ok: false };
}

function resolveCurrentVercelProject(
  opts: VerifyVercelOidcOptions,
): NonNullable<ResolvedOidcAuthStrategy["currentVercelProject"]> | undefined {
  if (opts.currentVercelProject !== undefined) return opts.currentVercelProject;
  return vercelCurrentProject();
}

/**
 * Allowed values for {@link VercelSubjectInput.environment}. Use `"*"`
 * to match any of `production`, `preview`, and `development` for the
 * named project.
 */
export type VercelSubjectEnvironment = "production" | "preview" | "development" | "*";

/**
 * Strict input shape accepted by {@link vercelSubject}.
 *
 * The `sub` claim carries human-readable slugs/names, not IDs. Stable
 * project and team IDs (`prj_...`, `team_...`) live on the separate
 * `project_id` / `owner_id` claims, which `verifyVercelOidc` matches
 * against `VERCEL_PROJECT_ID` for the current-project bind. This helper
 * composes a `sub` matcher, so its inputs are slugs.
 */
export interface VercelSubjectInput {
  /**
   * Vercel team slug (a.k.a. "owner"; e.g. `"acme"`) as embedded in the
   * `sub` claim, **not** the stable team ID `team_...` (`VERCEL_TEAM_ID`).
   *
   * Must not contain `*` or `:` so authors cannot widen the matcher to
   * "any team with a project of this name". Hand-write the subject string
   * when cross-team federation is intentional.
   */
  readonly teamSlug: string;
  /**
   * Vercel project name (e.g. `"acme_website"`) as embedded in the `sub`
   * claim, **not** the stable project ID `prj_...` (`VERCEL_PROJECT_ID`).
   * Same constraints as {@link teamSlug}.
   */
  readonly projectName: string;
  /**
   * Vercel deployment environment, or `"*"` to match any environment for
   * the named project. Defaults to `"production"` so an unspecified
   * environment cannot silently accept preview/development tokens.
   */
  readonly environment?: VercelSubjectEnvironment;
}

/**
 * Builds a Vercel OIDC `sub` matcher pattern from a typed input.
 *
 * Vercel-issued tokens carry a `sub` of the form
 * `owner:[TEAM_SLUG]:project:[PROJECT_NAME]:environment:[ENVIRONMENT]`.
 * Hand-writing it invites two foot-guns: a misspelled slug (silently
 * rejecting all callers) and over-broad wildcards (silently accepting
 * unrelated callers). This helper rejects malformed inputs at construction
 * time and forces an explicit `environment`.
 *
 * Use it inside {@link VerifyVercelOidcOptions.subjects} to layer
 * additional Vercel-project callers on top of the current-project bypass:
 *
 * ```ts
 * vercelOidc({
 *   subjects: [vercelSubject({ teamSlug: "partner", projectName: "data" })],
 * });
 * ```
 *
 * The `sub` claim flips when a team or project name changes, so any policy
 * built on this helper must update with it; the stable team/project IDs are
 * not exposed in `sub`. See Vercel's OIDC reference for the token anatomy.
 */
export function vercelSubject(input: VercelSubjectInput): string {
  assertVercelSubjectSegment("teamSlug", input.teamSlug);
  assertVercelSubjectSegment("projectName", input.projectName);
  const environment = input.environment ?? "production";
  if (
    environment !== "production" &&
    environment !== "preview" &&
    environment !== "development" &&
    environment !== "*"
  ) {
    throw new Error(
      `vercelSubject: invalid environment ${JSON.stringify(environment)}; expected "production", "preview", "development", or "*".`,
    );
  }
  return `owner:${input.teamSlug}:project:${input.projectName}:environment:${environment}`;
}

function assertVercelSubjectSegment(field: "teamSlug" | "projectName", value: string): void {
  if (value.length === 0) {
    throw new Error(`vercelSubject: ${field} must be a non-empty string.`);
  }
  if (value.includes("*") || value.includes(":")) {
    throw new Error(
      `vercelSubject: ${field} ${JSON.stringify(value)} may not contain ${value.includes(":") ? "':'" : "'*'"}. Hand-write the subject string when wildcards are intentional.`,
    );
  }
}

/** Verification options for the Vercel OIDC route authenticator. */
export type VercelOidcOptions = VerifyVercelOidcOptions;

/**
 * Returns an HTTP route auth callback backed by Vercel OIDC. See
 * {@link verifyVercelOidc} for the always-on current-project bypass and how
 * `subjects` extends acceptance to other Vercel projects. Declares a
 * `Bearer` {@link withAuthChallenges} challenge for {@link routeAuth}'s 401.
 */
export function vercelOidc(opts: VercelOidcOptions = {}): AuthFn<Request> {
  if (opts.subjects?.some((entry: unknown) => typeof entry !== "string")) {
    throw new TypeError(
      'vercelOidc: every subjects entry must be a string. For entries such as { subject, allowToolStubs: true }, use eveVercelOidc from "eve/channels/eve".',
    );
  }
  return withAuthChallenges(
    async (request) => {
      const token = extractBearerToken(request.headers.get("authorization"));
      const currentVercelProject =
        opts.currentVercelProject ??
        (token !== null && isLocalDevelopmentVercelOidc()
          ? await resolveVercelOidcCurrentProject(request)
          : undefined);
      const result = await verifyVercelOidc(
        token,
        currentVercelProject === undefined ? opts : { ...opts, currentVercelProject },
      );
      if (!result.ok) return null;
      return result.sessionAuth;
    },
    [{ scheme: "Bearer" }],
  );
}

function isLocalDevelopmentVercelOidc(): boolean {
  const environmentKind = vercelDeployment.environment();
  if (environmentKind === "development") return true;
  if (environmentKind === "preview" || environmentKind === "production") return false;
  return isEveDevEnvironment();
}
