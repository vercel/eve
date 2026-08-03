import { createPromptCommandOutput, withPhase, type ChannelSetupLog } from "#setup/cli/index.js";
import { replaceConnectTrigger } from "#setup/connect-provisioning.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import { z } from "zod";

export const GITHUB_TRIGGER_PATH = "/eve/v1/github";

/** Identity of the GitHub connector provisioned for an agent channel. */
export interface GitHubConnectorRef {
  id: string;
  uid: string;
}

/** Effects used to provision a GitHub Connect connector. */
export interface ProvisionGitHubConnectorDeps {
  runVercel: typeof runVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

const GitHubConnectorRefSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  supportedSubjectTypes: z.array(z.string()).refine((types) => types.includes("app")),
});

/** Parses `vercel connect create -F json` output for an app-scoped GitHub connector. */
export function parseCreatedGitHubConnector(stdout: string): GitHubConnectorRef | undefined {
  try {
    const parsed = GitHubConnectorRefSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? { id: parsed.data.id, uid: parsed.data.uid } : undefined;
  } catch {
    return undefined;
  }
}

/** Creates a GitHub connector and routes its verified webhooks to eve. */
export async function provisionGitHubConnector(input: {
  events: readonly string[];
  log: ChannelSetupLog;
  project: VercelProjectReference;
  projectRoot: string;
  slug: string;
  signal?: AbortSignal;
  deps?: ProvisionGitHubConnectorDeps;
}): Promise<GitHubConnectorRef> {
  const deps = input.deps ?? { runVercel, runVercelCaptureStdout };
  const onOutput = createPromptCommandOutput(input.log);
  const result = await withPhase(input.log, "Creating GitHub connector...", () =>
    deps.runVercelCaptureStdout(
      [
        "connect",
        "create",
        "github",
        "--name",
        input.slug,
        "--triggers",
        "--events",
        input.events.join(","),
        "-F",
        "json",
        "--scope",
        input.project.orgId,
      ],
      {
        cwd: input.projectRoot,
        nonInteractive: true,
        onOutput,
        signal: input.signal,
      },
    ),
  );
  input.signal?.throwIfAborted();
  if (!result.ok) {
    const detail = [result.stderr, result.stdout].find(
      (value): value is string => value !== undefined && value.trim().length > 0,
    );
    throw new Error(
      detail ? `GitHub connector creation failed:\n${detail}` : "GitHub connector creation failed.",
    );
  }
  const connector = parseCreatedGitHubConnector(result.stdout);
  if (connector === undefined) throw new Error("Vercel returned an invalid GitHub connector.");

  const attachment = await withPhase(input.log, "Connecting GitHub webhooks...", () =>
    replaceConnectTrigger({
      connectorUid: connector.uid,
      projectRoot: input.projectRoot,
      projectId: input.project.projectId,
      orgId: input.project.orgId,
      environment: "production",
      triggerPath: GITHUB_TRIGGER_PATH,
      onOutput,
      signal: input.signal,
      deps,
    }),
  );
  input.signal?.throwIfAborted();
  if (attachment.state !== "attached") {
    throw new Error(
      `GitHub connector was created, but its trigger could not be attached. Run \`vercel connect attach ${connector.uid} --project ${input.project.projectId} --environment production --triggers --trigger-path ${GITHUB_TRIGGER_PATH} --yes --scope ${input.project.orgId}\`.`,
    );
  }
  return connector;
}
