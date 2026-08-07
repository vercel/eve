import { createPromptCommandOutput, withPhase, type ChannelSetupLog } from "#setup/cli/index.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import { z } from "zod";

export const GITHUB_TRIGGER_PATH = "/eve/v1/github";

/** Identity of the GitHub connector provisioned for an agent channel. */
export interface GitHubConnectorRef {
  /** GitHub's actual @mention handle, without the `[bot]` suffix. */
  appSlug: string;
  id: string;
  uid: string;
}

/** Effects used to provision a GitHub Connect connector. */
export interface ProvisionGitHubConnectorDeps {
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

const GitHubConnectorRefSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  supportedSubjectTypes: z.array(z.string()).refine((types) => types.includes("app")),
});

const GitHubConnectorDetailsSchema = z.object({
  data: z.object({
    appSlug: z.string().min(1),
  }),
  id: z.string().min(1),
  type: z.literal("github"),
  uid: z.string().min(1),
});

/** Parses `vercel connect create -F json` output for an app-scoped GitHub connector. */
export function parseCreatedGitHubConnector(
  stdout: string,
): Omit<GitHubConnectorRef, "appSlug"> | undefined {
  try {
    const parsed = GitHubConnectorRefSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? { id: parsed.data.id, uid: parsed.data.uid } : undefined;
  } catch {
    return undefined;
  }
}

function parseGitHubConnectorDetails(
  stdout: string,
  connector: Omit<GitHubConnectorRef, "appSlug">,
): GitHubConnectorRef | undefined {
  try {
    const parsed = GitHubConnectorDetailsSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success || parsed.data.id !== connector.id || parsed.data.uid !== connector.uid) {
      return undefined;
    }
    return { ...connector, appSlug: parsed.data.data.appSlug };
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
  const deps = input.deps ?? { runVercelCaptureStdout };
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
        "--trigger-path",
        GITHUB_TRIGGER_PATH,
        ...input.events.flatMap((event) => ["--trigger-event", event]),
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
  const created = parseCreatedGitHubConnector(result.stdout);
  if (created === undefined) throw new Error("Vercel returned an invalid GitHub connector.");

  const details = await withPhase(input.log, "Reading GitHub App details...", () =>
    deps.runVercelCaptureStdout(
      [
        "api",
        `/v1/connect/connectors/${encodeURIComponent(created.id)}`,
        "--scope",
        input.project.orgId,
        "--raw",
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
  if (!details.ok) throw new Error("Could not read the created GitHub connector.");
  const connector = parseGitHubConnectorDetails(details.stdout, created);
  if (connector === undefined)
    throw new Error("Vercel returned invalid details for the GitHub connector.");

  return connector;
}
