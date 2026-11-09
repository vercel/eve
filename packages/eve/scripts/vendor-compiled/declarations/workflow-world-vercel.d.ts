import type { World } from "#compiled/@workflow/world/index.js";

export function createWorld(config?: {
  /** A Vercel auth token: required outside a deployment, where requests go through api.vercel.com. */
  readonly token?: string;
  /** The project outside a deployment; inside one, the deployment's OIDC token names it. */
  readonly projectConfig?: {
    readonly projectId?: string;
    readonly projectName?: string;
    readonly teamId?: string;
    readonly environment?: string;
  };
}): World;
