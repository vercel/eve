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

const ManagedCreateResponseSchema = z.object({
  connectorId: z.string().min(1),
  url: z.string().url(),
});

const TeamsConnectorSchema = z.object({
  id: z.string().min(1),
  type: z.literal("microsoft-teams"),
  uid: z.string().min(1),
});

export function parseManagedTeamsCreate(
  stdout: string,
): { connectorId: string; url: string } | undefined {
  try {
    const parsed = ManagedCreateResponseSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function parseTeamsConnector(
  stdout: string,
  connectorId: string,
): TeamsConnectorRef | undefined {
  try {
    const parsed = TeamsConnectorSchema.safeParse(JSON.parse(stdout));
    return parsed.success && parsed.data.id === connectorId
      ? { id: parsed.data.id, uid: parsed.data.uid }
      : undefined;
  } catch {
    return undefined;
  }
}

function commandFailure(label: string, result: { stderr?: string; stdout?: string }): Error {
  const detail = [result.stderr, result.stdout].find(
    (value): value is string => value !== undefined && value.trim().length > 0,
  );
  return new Error(detail ? `${label} failed:\n${detail}` : `${label} failed.`);
}

/** Starts the managed Teams creation flow, which completes in the administrator's browser. */
export async function createManagedTeamsConnector(input: {
  name: string;
  resourceGroup?: string;
  subscriptionId: string;
  log: ChannelSetupLog;
  project: VercelProjectReference;
  projectRoot: string;
  signal?: AbortSignal;
  deps?: ProvisionTeamsConnectorDeps;
}): Promise<{ connectorId: string; url: string }> {
  const deps = input.deps ?? { runVercel, runVercelCaptureStdout };
  const result = await withPhase(input.log, "Creating Microsoft Teams bot…", () =>
    deps.runVercelCaptureStdout(
      [
        "api",
        "/v1/connect/connectors/managed/microsoft-teams",
        "-X",
        "POST",
        "--input",
        "-",
        "--raw",
        "--scope",
        input.project.orgId,
      ],
      {
        cwd: input.projectRoot,
        nonInteractive: true,
        onOutput: createPromptCommandOutput(input.log),
        signal: input.signal,
        stdin: JSON.stringify({
          name: input.name,
          projectId: input.project.projectId,
          input: {
            subscriptionId: input.subscriptionId,
            ...(input.resourceGroup === undefined ? {} : { resourceGroup: input.resourceGroup }),
          },
        }),
      },
    ),
  );
  input.signal?.throwIfAborted();
  if (!result.ok) throw commandFailure("Microsoft Teams bot creation", result);
  const created = parseManagedTeamsCreate(result.stdout);
  if (created === undefined)
    throw new Error("Vercel returned an invalid Microsoft Teams creation request.");
  return created;
}

/** Reads the managed connector after its browser creation flow has completed. */
export async function readTeamsConnector(input: {
  connectorId: string;
  log: ChannelSetupLog;
  project: VercelProjectReference;
  projectRoot: string;
  signal?: AbortSignal;
  deps?: ProvisionTeamsConnectorDeps;
}): Promise<TeamsConnectorRef> {
  const deps = input.deps ?? { runVercel, runVercelCaptureStdout };
  const result = await withPhase(input.log, "Reading Microsoft Teams bot…", () =>
    deps.runVercelCaptureStdout(
      [
        "api",
        `/v1/connect/connectors/${encodeURIComponent(input.connectorId)}`,
        "--scope",
        input.project.orgId,
        "--raw",
      ],
      {
        cwd: input.projectRoot,
        nonInteractive: true,
        onOutput: createPromptCommandOutput(input.log),
        signal: input.signal,
      },
    ),
  );
  input.signal?.throwIfAborted();
  if (!result.ok) throw commandFailure("Microsoft Teams bot lookup", result);
  const connector = parseTeamsConnector(result.stdout, input.connectorId);
  if (connector === undefined)
    throw new Error("Vercel returned invalid details for the Microsoft Teams bot.");
  return connector;
}

/** Attaches the managed Teams bot's verified Activity trigger to eve. */
export async function attachTeamsTrigger(input: {
  connector: TeamsConnectorRef;
  log: ChannelSetupLog;
  project: VercelProjectReference;
  projectRoot: string;
  signal?: AbortSignal;
  deps?: ProvisionTeamsConnectorDeps;
}): Promise<void> {
  const deps = input.deps ?? { runVercel, runVercelCaptureStdout };
  const args = [
    "connect",
    "attach",
    input.connector.uid,
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
    deps.runVercel(args, {
      cwd: input.projectRoot,
      nonInteractive: true,
      onOutput: createPromptCommandOutput(input.log),
      signal: input.signal,
    }),
  );
  input.signal?.throwIfAborted();
  if (!attached) {
    throw new Error(
      `Microsoft Teams bot was created, but its trigger could not be attached. Run \`vercel ${args.join(" ")}\`.`,
    );
  }
}
