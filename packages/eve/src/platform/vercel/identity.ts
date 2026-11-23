import type { CurrentVercelProject } from "#channel/auth/types.js";
import type { Identity } from "#platform/entities.js";
import { vercelEnvironmentName } from "#platform/vercel/deployment.js";
import { withVercelOidcProjectResolver } from "#platform/vercel/oidc-project.js";

export function vercelCurrentProject(): CurrentVercelProject | undefined {
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (projectId === undefined || projectId.length === 0) return undefined;
  const environment = vercelEnvironmentName();
  return environment === undefined ? { projectId } : { environment, projectId };
}

export const vercelIdentity = {
  developmentScope: (input, run) =>
    withVercelOidcProjectResolver(
      {
        request: input.request,
        resolveCurrentProject: async () => {
          const { readVercelProjectLink } = await import("#internal/vercel/project-link.js");
          const link = await readVercelProjectLink(input.appRoot);
          return link === undefined
            ? undefined
            : { environment: "development", projectId: link.projectId };
        },
      },
      run,
    ),
} satisfies Identity;
