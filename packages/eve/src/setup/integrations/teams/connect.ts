import { createPromptCommandOutput, withPhase, type ChannelSetupLog } from "#setup/cli/index.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import { z } from "zod";

export const TEAMS_TRIGGER_PATH = "/eve/v1/teams";

export interface TeamsConnectorRef {
  id: string;
  uid: string;
}

export interface ProvisionTeamsConnectorDeps {
  runVercel: typeof runVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

const TeamsConnectorSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
});

export function parseCreatedTeamsConnector(stdout: string): TeamsConnectorRef | undefined {
  try {
    const parsed = TeamsConnectorSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Creates and installs a Teams app through the Vercel Connect CLI. */
export async function provisionTeamsConnector(input: {
  name: string;
  log: ChannelSetupLog;
  project: VercelProjectReference;
  projectRoot: string;
  signal?: AbortSignal;
  deps?: ProvisionTeamsConnectorDeps;
}): Promise<TeamsConnectorRef> {
  const deps = input.deps ?? { runVercel, runVercelCaptureStdout };
  const onOutput = createPromptCommandOutput(input.log);
  const result = await withPhase(input.log, "Creating Microsoft Teams connector…", () =>
    deps.runVercelCaptureStdout(
      [
        "connect",
        "create",
        "microsoft-teams",
        "--name",
        input.name,
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
      detail
        ? `Microsoft Teams connector creation failed:\n${detail}`
        : "Microsoft Teams connector creation failed.",
    );
  }
  const connector = parseCreatedTeamsConnector(result.stdout);
  if (connector === undefined)
    throw new Error("Vercel returned an invalid Microsoft Teams connector.");

  const attachArgs = [
    "connect",
    "attach",
    connector.uid,
    "--project",
    input.project.projectId,
    "--environment",
    "production",
    "--triggers",
    "--trigger-path",
    TEAMS_TRIGGER_PATH,
    "--yes",
    "--scope",
    input.project.orgId,
  ];
  const attached = await withPhase(input.log, "Connecting Microsoft Teams activities…", () =>
    deps.runVercel(attachArgs, {
      cwd: input.projectRoot,
      nonInteractive: true,
      onOutput,
      signal: input.signal,
    }),
  );
  input.signal?.throwIfAborted();
  if (!attached) {
    throw new Error(
      `Microsoft Teams connector was created, but its trigger destination could not be registered. Run \`vercel ${attachArgs.join(" ")}\`.`,
    );
  }
  return connector;
}
