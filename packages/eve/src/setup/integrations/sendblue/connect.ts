import type { ChannelSetupLog } from "#setup/cli/index.js";
import { createPromptCommandOutput, withPhase } from "#setup/cli/index.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import {
  runVercelCaptureStdout,
  type RunVercelCaptureResult,
} from "#setup/primitives/run-vercel.js";
import { z } from "zod";

export const SENDBLUE_CONNECT_SERVICE = "sendblue";
export const SENDBLUE_TRIGGER_PATH = "/eve/v1/sendblue";

export interface SendblueConnectorRef {
  id: string;
  uid: string;
}

export interface ProvisionSendblueConnectorDeps {
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

export interface ProvisionSendblueConnectorOptions {
  log: ChannelSetupLog;
  project: VercelProjectReference;
  projectRoot: string;
  slug: string;
  signal?: AbortSignal;
  deps?: ProvisionSendblueConnectorDeps;
}

const CreatedSendblueConnectorSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  supportedSubjectTypes: z.array(z.string()).refine((types) => types.includes("app")),
});
type CreatedSendblueConnector = SendblueConnectorRef;

export function parseCreatedSendblueConnector(
  stdout: string,
): CreatedSendblueConnector | undefined {
  try {
    const parsed = CreatedSendblueConnectorSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? { id: parsed.data.id, uid: parsed.data.uid } : undefined;
  } catch {
    return undefined;
  }
}

function requireCreatedConnector(result: RunVercelCaptureResult): CreatedSendblueConnector {
  if (!result.ok) {
    const detail = [result.stderr, result.stdout]
      .map((output) => output?.trim())
      .find((output): output is string => output !== undefined && output.length > 0);
    throw new Error(
      detail
        ? `Sendblue connector creation failed:\n${detail}`
        : "Sendblue connector creation failed.",
    );
  }
  const connector = parseCreatedSendblueConnector(result.stdout);
  if (connector === undefined) throw new Error("Vercel returned an invalid Sendblue connector.");
  return connector;
}

/** Creates a managed Sendblue account and routes its verified events to eve. */
export async function provisionSendblueConnector(
  options: ProvisionSendblueConnectorOptions,
): Promise<SendblueConnectorRef> {
  const deps = options.deps ?? { runVercelCaptureStdout };
  const onOutput = createPromptCommandOutput(options.log);
  const created = requireCreatedConnector(
    await withPhase(options.log, "Creating Sendblue account...", () =>
      deps.runVercelCaptureStdout(
        [
          "connect",
          "create",
          SENDBLUE_CONNECT_SERVICE,
          "--name",
          options.slug,
          "--triggers",
          "--trigger-path",
          SENDBLUE_TRIGGER_PATH,
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
        },
      ),
    ),
  );
  options.signal?.throwIfAborted();
  return created;
}
