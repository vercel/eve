import { readProjectLink, type VercelProjectReference } from "#setup/project-resolution.js";

import { SetupPrerequisiteRequired } from "./prerequisite.js";

export interface IntegrationVercelProjectDeps {
  readProjectLink: typeof readProjectLink;
}

const defaultDeps: IntegrationVercelProjectDeps = { readProjectLink };

/** Requires the caller to link a Vercel project before integration setup begins applying. */
export async function resolveIntegrationVercelProject(input: {
  appRoot: string;
  integration: string;
  signal?: AbortSignal;
  deps?: IntegrationVercelProjectDeps;
}): Promise<VercelProjectReference> {
  input.signal?.throwIfAborted();
  const project = await (input.deps ?? defaultDeps).readProjectLink(input.appRoot);
  if (project !== undefined) return project;

  throw new SetupPrerequisiteRequired({
    kind: "command",
    code: "vercel-project-link",
    message: `Vercel Connect setup requires a linked Vercel project. Run \`eve link\`, then retry ${input.integration} setup.`,
    command: "eve link",
  });
}
