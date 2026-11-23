import { vercelOidc } from "#platform/vercel/agent-auth.js";
import { vercelDeployment, vercelDeploymentHost } from "#platform/vercel/deployment.js";
import { isVercelEnvironment } from "#platform/vercel/environment.js";
import type { WorkspaceAgentTransport } from "#public/definitions/workspace-agent.js";

export function vercelWorkspaceTransport(routePath: string): WorkspaceAgentTransport | undefined {
  if (!isVercelEnvironment()) return undefined;
  const auth = vercelOidc();
  return {
    auth: async () => (vercelDeployment.environment() === "development" ? { headers: {} } : auth()),
    url: () => {
      const development = vercelDeployment.environment() === "development";
      const host =
        vercelDeployment.environment() === "production"
          ? vercelDeployment.productionHost()
          : vercelDeploymentHost();
      if (host === undefined || host.length === 0) {
        throw new Error(
          "The default workspace-agent transport requires VERCEL_URL, or VERCEL_PROJECT_PRODUCTION_URL in production.",
        );
      }
      return `${development ? "http" : "https"}://${host}${routePath}`;
    },
  };
}
