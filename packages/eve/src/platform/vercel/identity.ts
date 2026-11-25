import type { JWTPayload } from "#compiled/jose/index.js";
import { createJwtAuthenticatedCallerPrincipal } from "#channel/auth/token-claims.js";
import type { CurrentVercelProject, ResolvedOidcAuthStrategy } from "#channel/auth/types.js";
import {
  withDevelopmentIdentity,
  type Identity,
  type OidcCallerVerdict,
} from "#platform/entities.js";
import { vercelEnvironmentName } from "#platform/vercel/deployment.js";
import { withVercelOidcProjectResolver } from "#platform/vercel/oidc-project.js";
import { isVercelOidcIssuer } from "#platform/vercel/project.js";

const NOT_CURRENT_PROJECT: OidcCallerVerdict = {
  kind: "continue",
  currentProject: false,
  runtime: false,
};

export function vercelCurrentProject(): CurrentVercelProject | undefined {
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (projectId === undefined || projectId.length === 0) return undefined;
  const environment = vercelEnvironmentName();
  return environment === undefined ? { projectId } : { environment, projectId };
}

function currentProjectMatches(payload: JWTPayload, strategy: ResolvedOidcAuthStrategy): boolean {
  const currentProject = strategy.currentVercelProject;
  if (currentProject === undefined) {
    return false;
  }

  return typeof payload.project_id === "string" && payload.project_id === currentProject.projectId;
}

function currentEnvironmentMatches(
  payload: JWTPayload,
  strategy: ResolvedOidcAuthStrategy,
): boolean {
  const currentEnvironment = strategy.currentVercelProject?.environment;
  if (currentEnvironment === undefined || currentEnvironment.length === 0) {
    return false;
  }

  return typeof payload.environment === "string" && payload.environment === currentEnvironment;
}

export const vercelIdentity = withDevelopmentIdentity(
  {
    verifyOidcCaller({ issuer, payload, strategy }): OidcCallerVerdict {
      if (!strategy.acceptCurrentVercelProject || !isVercelOidcIssuer(issuer)) {
        return NOT_CURRENT_PROJECT;
      }

      if (payload.external_sub !== undefined) {
        if (
          typeof payload.external_sub !== "string" ||
          payload.external_sub.length === 0 ||
          !currentProjectMatches(payload, strategy) ||
          !currentEnvironmentMatches(payload, strategy)
        ) {
          return { kind: "caller-not-allowed" };
        }

        return {
          kind: "authenticated",
          principal: createJwtAuthenticatedCallerPrincipal({
            authenticator: "oidc",
            issuerClaims: ["external_iss", "connector_id"],
            payload,
            principalType: "user",
            subjectClaim: "external_sub",
          }),
        };
      }

      if (payload.user_id !== undefined) {
        if (
          typeof payload.user_id !== "string" ||
          payload.user_id.length === 0 ||
          payload.environment !== "development" ||
          !currentProjectMatches(payload, strategy)
        ) {
          return { kind: "caller-not-allowed" };
        }

        if (currentEnvironmentMatches(payload, strategy)) {
          return {
            kind: "authenticated",
            principal: createJwtAuthenticatedCallerPrincipal({
              authenticator: "oidc",
              payload,
              principalType: "user",
              subjectClaim: "user_id",
            }),
          };
        }
      }

      const currentProject = currentProjectMatches(payload, strategy);
      return {
        kind: "continue",
        currentProject,
        runtime: currentProject && currentEnvironmentMatches(payload, strategy),
      };
    },
  } satisfies Identity,
  {
    caller: (current) =>
      current.authenticator === "oidc" &&
      isVercelOidcIssuer(current.issuer) &&
      current.attributes.environment === "development" &&
      current.subject === current.attributes.user_id,
    scope: (input, run) =>
      withVercelOidcProjectResolver(
        {
          request: input.request,
          resolveCurrentProject: async () => {
            const { readVercelProjectLink } = await import("#runtime-env/vercel-project-link.js");
            const link = await readVercelProjectLink(input.appRoot);
            return link === undefined
              ? undefined
              : { environment: "development", projectId: link.projectId };
          },
        },
        run,
      ),
  },
);
