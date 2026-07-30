import type { ChannelSetupLog } from "#setup/cli/index.js";
import { createPromptCommandOutput, withPhase } from "#setup/cli/index.js";
import { replaceConnectTrigger } from "#setup/connect-provisioning.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import {
  runVercel,
  runVercelCaptureStdout,
  type RunVercelCaptureResult,
} from "#setup/primitives/run-vercel.js";
import { z } from "zod";

export const PHOTON_CONNECT_SERVICE = "photon";
export const PHOTON_CONNECTOR_TYPE = "photon";
export const PHOTON_TRIGGER_PATH = "/eve/v1/photon";

/** Photon project credentials collected separately from their Connect storage encoding. */
export interface PhotonProjectCredentials {
  projectId: string;
  projectSecret: string;
}

/** Identity of a native Photon connector created through Vercel Connect. */
export interface PhotonConnectorRef {
  id: string;
  uid: string;
  /** Direct project URL used until Photon is available as a managed trigger connector. */
  webhookUrl?: string;
}

/** Effects used to provision a Photon connector. */
export interface ProvisionPhotonConnectorDeps {
  runVercel: typeof runVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

/** Input for provisioning one Photon connector and its eve webhook destination. */
export interface ProvisionPhotonConnectorOptions {
  credentials: PhotonProjectCredentials;
  log: ChannelSetupLog;
  project: VercelProjectReference;
  projectRoot: string;
  slug: string;
  signal?: AbortSignal;
  deps?: ProvisionPhotonConnectorDeps;
}

const PhotonConnectorRefSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  supportedSubjectTypes: z.array(z.string()).refine((types) => types.includes("app")),
});

/** Parses `vercel connect create -F json` output for a Photon connector. */
export function parseCreatedPhotonConnector(stdout: string): PhotonConnectorRef | undefined {
  try {
    const parsed = PhotonConnectorRefSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? { id: parsed.data.id, uid: parsed.data.uid } : undefined;
  } catch {
    return undefined;
  }
}

function createData(credentials: PhotonProjectCredentials): string {
  return JSON.stringify({
    projectId: credentials.projectId.trim(),
    projectSecret: credentials.projectSecret.trim(),
  });
}

function requireCreatedConnector(result: RunVercelCaptureResult): PhotonConnectorRef {
  if (!result.ok) {
    const detail = [result.stderr, result.stdout]
      .map((output) => output?.trim())
      .find((output): output is string => output !== undefined && output.length > 0);
    throw new Error(
      detail ? `Photon connector creation failed:\n${detail}` : "Photon connector creation failed.",
    );
  }
  const connector = parseCreatedPhotonConnector(result.stdout);
  if (connector === undefined) {
    throw new Error("Vercel returned an invalid Photon connector after creation.");
  }
  return connector;
}

/**
 * Creates a native Photon connector and attaches its verified webhook trigger
 * to the linked project. Secrets travel over stdin, never argv.
 */
export async function provisionPhotonConnector(
  options: ProvisionPhotonConnectorOptions,
): Promise<PhotonConnectorRef> {
  const deps = options.deps ?? { runVercel, runVercelCaptureStdout };
  const onOutput = createPromptCommandOutput(options.log);
  const result = await withPhase(options.log, "Creating Photon connector...", () =>
    deps.runVercelCaptureStdout(
      [
        "connect",
        "create",
        PHOTON_CONNECT_SERVICE,
        "--connector-type",
        PHOTON_CONNECTOR_TYPE,
        "--data",
        "@-",
        "--name",
        options.slug,
        "--triggers",
        "-F",
        "json",
        "--scope",
        options.project.orgId,
      ],
      {
        cwd: options.projectRoot,
        nonInteractive: true,
        onOutput,
        signal: options.signal,
        stdin: createData(options.credentials),
      },
    ),
  );
  options.signal?.throwIfAborted();
  const connector = requireCreatedConnector(result);

  // Creation can auto-attach the cwd's linked project with a pathless default
  // destination. Replace it so Connect has exactly one routed destination.
  const attachment = await withPhase(options.log, "Connecting Photon credentials...", () =>
    replaceConnectTrigger({
      connectorUid: connector.uid,
      projectRoot: options.projectRoot,
      projectId: options.project.projectId,
      orgId: options.project.orgId,
      environment: "production",
      triggerPath: PHOTON_TRIGGER_PATH,
      onOutput,
      signal: options.signal,
      deps,
    }),
  );
  options.signal?.throwIfAborted();
  if (attachment.state !== "attached") {
    const command = `vercel connect attach ${connector.uid} --project ${options.project.projectId} --environment production --triggers --trigger-path ${PHOTON_TRIGGER_PATH} --yes --scope ${options.project.orgId}`;
    throw new Error(
      attachment.state === "detach-failed"
        ? `Photon connector was created, but its default trigger destination could not be removed. Run \`vercel connect detach ${connector.uid} --project ${options.project.projectId} --yes --scope ${options.project.orgId}\`, then \`${command}\`.`
        : `Photon connector was created, but its credentials could not be attached. Run \`${command}\`.`,
    );
  }

  return connector;
}
