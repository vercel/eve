import { createPromptCommandOutput, withPhase, type ChannelSetupLog } from "#setup/cli/index.js";
import { replaceConnectTrigger } from "#setup/connect-provisioning.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import { z } from "zod";

export const LINEAR_TRIGGER_PATH = "/eve/v1/linear";
const LINEAR_AGENT_SESSION_TRIGGER_EVENT = "AgentSessionEvent";

/** Identity of the Linear connector provisioned for an agent channel. */
export interface LinearConnectorRef {
  id: string;
  uid: string;
}

/** Effects used to provision a Linear Connect connector. */
export interface ProvisionLinearConnectorDeps {
  runVercel: typeof runVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

const LinearConnectorRefSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  supportedSubjectTypes: z.array(z.string()).refine((types) => types.includes("app")),
});

/** Parses `vercel connect create -F json` output for an app-scoped Linear connector. */
export function parseCreatedLinearConnector(stdout: string): LinearConnectorRef | undefined {
  try {
    const parsed = LinearConnectorRefSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? { id: parsed.data.id, uid: parsed.data.uid } : undefined;
  } catch {
    return undefined;
  }
}

/** Finds the canonical Linear connector if it already exists in this Vercel team. */
export async function findLinearConnector(input: {
  project: VercelProjectReference;
  projectRoot: string;
  slug: string;
  signal?: AbortSignal;
  deps?: ProvisionLinearConnectorDeps;
}): Promise<LinearConnectorRef | undefined> {
  const deps = input.deps ?? { runVercel, runVercelCaptureStdout };
  const result = await deps.runVercelCaptureStdout(
    [
      "connect",
      "list",
      "--all-projects",
      "--service",
      "linear",
      "-F",
      "json",
      "--scope",
      input.project.orgId,
    ],
    { cwd: input.projectRoot, nonInteractive: true, signal: input.signal },
  );
  if (!result.ok) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { connectors?: unknown };
    if (!Array.isArray(parsed.connectors)) return undefined;
    const expectedUid = `linear/${input.slug}`;
    const connector = parsed.connectors.find(
      (value): value is Record<string, unknown> =>
        typeof value === "object" &&
        value !== null &&
        (value as { uid?: unknown }).uid === expectedUid,
    );
    return typeof connector?.id === "string" ? { id: connector.id, uid: expectedUid } : undefined;
  } catch {
    return undefined;
  }
}

/** Attaches a Linear connector's verified events to this agent's production route. */
export async function attachLinearConnector(input: {
  connector: LinearConnectorRef;
  log: ChannelSetupLog;
  project: VercelProjectReference;
  projectRoot: string;
  signal?: AbortSignal;
  deps?: ProvisionLinearConnectorDeps;
}): Promise<void> {
  const deps = input.deps ?? { runVercel, runVercelCaptureStdout };
  const onOutput = createPromptCommandOutput(input.log);
  const attachment = await withPhase(input.log, "Connecting Linear Agent Sessions...", () =>
    replaceConnectTrigger({
      connectorUid: input.connector.uid,
      projectRoot: input.projectRoot,
      projectId: input.project.projectId,
      orgId: input.project.orgId,
      environment: "production",
      triggerPath: LINEAR_TRIGGER_PATH,
      onOutput,
      signal: input.signal,
      deps,
    }),
  );
  input.signal?.throwIfAborted();
  if (attachment.state !== "attached") {
    throw new Error(
      `Linear connector was found, but its trigger could not be attached. Run \`vercel connect attach ${input.connector.uid} --project ${input.project.projectId} --environment production --triggers --trigger-path ${LINEAR_TRIGGER_PATH} --yes --scope ${input.project.orgId}\`.`,
    );
  }
}

/** Creates a Linear connector and routes its verified Agent Session events to eve. */
export async function provisionLinearConnector(input: {
  log: ChannelSetupLog;
  project: VercelProjectReference;
  projectRoot: string;
  slug: string;
  signal?: AbortSignal;
  deps?: ProvisionLinearConnectorDeps;
}): Promise<LinearConnectorRef> {
  const deps = input.deps ?? { runVercel, runVercelCaptureStdout };
  const onOutput = createPromptCommandOutput(input.log);
  const result = await withPhase(input.log, "Creating Linear connector...", () =>
    deps.runVercelCaptureStdout(
      [
        "connect",
        "create",
        "linear",
        "--name",
        input.slug,
        "--triggers",
        "--trigger-event",
        LINEAR_AGENT_SESSION_TRIGGER_EVENT,
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
      detail ? `Linear connector creation failed:\n${detail}` : "Linear connector creation failed.",
    );
  }
  const connector = parseCreatedLinearConnector(result.stdout);
  if (connector === undefined) throw new Error("Vercel returned an invalid Linear connector.");

  await attachLinearConnector({ ...input, connector, deps });
  return connector;
}
