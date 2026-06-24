import { resolveVercelDeployment, type VerifiedVercelTarget } from "#setup/vercel-deployment.js";

/** Builds a branded target through the production parser for unit tests. */
export async function resolveTestVercelTarget(input: {
  readonly host: string;
  readonly projectId?: string;
  readonly ownerId?: string;
  readonly projectName?: string;
  readonly environment?: "preview" | "production";
}): Promise<VerifiedVercelTarget> {
  const environment = input.environment ?? "preview";
  const result = await resolveVercelDeployment({
    workspaceRoot: "/test-workspace",
    host: input.host,
    source: {
      orgId: input.ownerId ?? "team_test",
      projectId: input.projectId ?? "prj_test",
    },
    deps: {
      captureVercel: async () => ({
        ok: true,
        stdout: JSON.stringify({
          ownerId: input.ownerId ?? "team_test",
          projectId: input.projectId ?? "prj_test",
          name: input.projectName ?? "test-project",
          target: environment,
          customEnvironment: null,
        }),
      }),
    },
  });
  if (result.kind !== "resolved") {
    throw new Error(`Expected a verified Vercel target, received ${result.kind}.`);
  }
  return result.target;
}
