import { createPromptCommandOutput, withPhase, type ChannelSetupLog } from "#setup/cli/index.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { captureVercel, runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import { z } from "zod";

const CONNECTOR_TYPE = "api-key";
const SERVICE = "api.resend.com";

const ConnectorSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  type: z.string().optional(),
  service: z.string().optional(),
  supportedSubjectTypes: z.array(z.string()).optional(),
});

/** Identity of the generic API-key connector used for Resend. */
export interface ResendConnectorRef {
  id: string;
  uid: string;
}

export interface ResendConnectDeps {
  captureVercel: typeof captureVercel;
  runVercel: typeof runVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

function connectorList(stdout: string): unknown[] {
  try {
    const body = JSON.parse(stdout) as { connectors?: unknown; clients?: unknown };
    const connectors = body.connectors ?? body.clients;
    return Array.isArray(connectors) ? connectors : [];
  } catch {
    throw new Error("Vercel returned an invalid connector list.");
  }
}

function compatible(raw: z.infer<typeof ConnectorSchema>): boolean {
  return (
    (raw.type === undefined || raw.type === CONNECTOR_TYPE) &&
    (raw.service === undefined || raw.service === SERVICE) &&
    (raw.supportedSubjectTypes === undefined || raw.supportedSubjectTypes.includes("app"))
  );
}

/** Creates or reuses the deterministic generic Connect connector and attaches it to production. */
export async function provisionResendConnector(input: {
  apiKey: string;
  log: ChannelSetupLog;
  project: VercelProjectReference;
  projectRoot: string;
  slug: string;
  signal?: AbortSignal;
  deps?: ResendConnectDeps;
}): Promise<ResendConnectorRef> {
  const deps = input.deps ?? { captureVercel, runVercel, runVercelCaptureStdout };
  const uid = `${CONNECTOR_TYPE}/${input.slug}`;
  const onOutput = createPromptCommandOutput(input.log);
  const listed = await deps.captureVercel(["connect", "list", "-F", "json", "--all-projects"], {
    cwd: input.projectRoot,
    onOutput,
    signal: input.signal,
  });
  if (!listed.ok) throw new Error("Could not inspect existing Vercel Connect connectors.");
  const existingRaw = connectorList(listed.stdout).find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { uid?: unknown }).uid === uid,
  );

  let connector: ResendConnectorRef;
  if (existingRaw !== undefined) {
    const parsed = ConnectorSchema.safeParse(existingRaw);
    if (!parsed.success || !compatible(parsed.data)) {
      throw new Error(
        `Connector ${uid} already exists but is not an API-key connector for ${SERVICE}. Choose a different agent name or remove the incompatible connector.`,
      );
    }
    connector = { id: parsed.data.id, uid: parsed.data.uid };
  } else {
    const created = await withPhase(input.log, "Creating Resend connector...", () =>
      deps.runVercelCaptureStdout(
        [
          "connect",
          "create",
          SERVICE,
          "--connector-type",
          CONNECTOR_TYPE,
          "--data",
          "@-",
          "--name",
          input.slug,
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
          stdin: JSON.stringify({ values: [{ value: input.apiKey }] }),
        },
      ),
    );
    if (!created.ok) throw new Error("Resend connector creation failed.");
    let body: unknown;
    try {
      body = JSON.parse(created.stdout) as unknown;
    } catch {
      throw new Error("Vercel returned invalid JSON after creating the Resend connector.");
    }
    const parsed = ConnectorSchema.safeParse(body);
    if (!parsed.success || !compatible(parsed.data)) {
      throw new Error("Vercel returned an invalid Resend API-key connector.");
    }
    connector = { id: parsed.data.id, uid: parsed.data.uid };
  }

  const attached = await withPhase(input.log, "Attaching Resend credentials...", () =>
    deps.runVercel(
      [
        "connect",
        "attach",
        connector.uid,
        "--project",
        input.project.projectId,
        "--environment",
        "production",
        "--yes",
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
  if (!attached) {
    throw new Error(
      `Connector ${connector.uid} exists but could not be attached. Run \`vercel connect attach ${connector.uid} --project ${input.project.projectId} --environment production --yes --scope ${input.project.orgId}\`.`,
    );
  }
  return connector;
}
