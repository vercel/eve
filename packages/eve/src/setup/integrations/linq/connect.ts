import type { ChannelSetupLog } from "#setup/cli/index.js";
import { createPromptCommandOutput, withPhase } from "#setup/cli/index.js";
import type { ProcessOutputHandler } from "#setup/primitives/process-output.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import { replaceConnectTrigger } from "#setup/connect-provisioning.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import {
  runVercel,
  runVercelCaptureStdout,
  type RunVercelCaptureResult,
} from "#setup/primitives/run-vercel.js";
import { z } from "zod";

export const LINQ_TRIGGER_PATH = "/eve/v1/linq";
export const LINQ_TRIGGER_EVENTS = ["message.received", "reaction.added", "reaction.removed"];

export interface LinqConnectorRef {
  id: string;
  uid: string;
  phoneNumber?: string;
}

export interface ProvisionLinqConnectorDeps {
  runVercel: typeof runVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

/** Credentials for a connector backed by an existing Linq account. */
export interface LinqExistingAccountCredentials {
  apiToken: string;
  phoneNumbers: string[];
}

const ConnectorSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  supportedSubjectTypes: z.array(z.string()).refine((types) => types.includes("app")),
  data: z.object({ phoneNumbers: z.array(z.string().min(1)).optional() }).optional(),
});

/** Parses Vercel Connect JSON for an app-scoped Linq connector. */
export function parseCreatedLinqConnector(stdout: string): LinqConnectorRef | undefined {
  try {
    const result = ConnectorSchema.safeParse(JSON.parse(stdout));
    if (!result.success) return undefined;
    const phoneNumber = result.data.data?.phoneNumbers?.[0];
    const connector: LinqConnectorRef = { id: result.data.id, uid: result.data.uid };
    if (phoneNumber !== undefined) connector.phoneNumber = phoneNumber;
    return connector;
  } catch {
    return undefined;
  }
}

function requireCreatedConnector(result: RunVercelCaptureResult): LinqConnectorRef {
  if (!result.ok) {
    const output = `${result.stderr ?? ""}\n${result.stdout}`;
    if (/(?:unknown|unexpected|invalid).*--trigger-event/iu.test(output)) {
      throw new HumanActionRequiredError({
        kind: "vercel-cli-upgrade",
        command: "vercel upgrade",
        reason:
          "The installed Vercel CLI does not support the trigger options Linq setup needs. Upgrade it and retry.",
      });
    }
    const detail = [result.stderr, result.stdout].find(
      (value): value is string => value !== undefined && value.trim().length > 0,
    );
    throw new Error(
      detail ? `Linq connector creation failed:\n${detail}` : "Linq connector creation failed.",
    );
  }
  const connector = parseCreatedLinqConnector(result.stdout);
  if (connector === undefined) throw new Error("Vercel returned an invalid Linq connector.");
  return connector;
}

/** Creates a managed Linq connector and routes verified events to eve. */
export async function provisionLinqConnector(input: {
  /** When omitted, Connect opens Linq's managed browser flow to provision a line. */
  existingAccount?: LinqExistingAccountCredentials;
  log: ChannelSetupLog;
  project: VercelProjectReference;
  projectRoot: string;
  slug: string;
  signal?: AbortSignal;
  deps?: ProvisionLinqConnectorDeps;
}): Promise<LinqConnectorRef> {
  const deps = input.deps ?? { runVercel, runVercelCaptureStdout };
  const commandOutput = createPromptCommandOutput(input.log);
  const onOutput: ProcessOutputHandler = (line) => {
    // The headless-browser shim captures this URL separately. Keeping it out
    // of the setup renderer prevents terminal wrapping from making it unusable.
    if (URL.parse(line.text) !== null) return;
    commandOutput(line);
  };
  const command = ["connect", "create", "linq", "--name", input.slug];
  const stdin =
    input.existingAccount === undefined
      ? undefined
      : JSON.stringify({
          apiToken: input.existingAccount.apiToken,
          phoneNumbers: input.existingAccount.phoneNumbers,
        });
  if (stdin !== undefined) command.push("--connector-type", "linq", "--data", "@-");
  command.push(
    "--triggers",
    ...LINQ_TRIGGER_EVENTS.flatMap((event) => ["--trigger-event", event]),
    "-F",
    "json",
    "--scope",
    input.project.orgId,
  );
  const result = await withPhase(input.log, "Creating Linq connector...", () =>
    deps.runVercelCaptureStdout(command, {
      cwd: input.projectRoot,
      nonInteractive: true,
      onOutput,
      signal: input.signal,
      stdin,
    }),
  );
  input.signal?.throwIfAborted();
  const created = requireCreatedConnector(result);
  const connector = await readLinqConnector({
    connector: created,
    projectRoot: input.projectRoot,
    orgId: input.project.orgId,
    signal: input.signal,
    deps,
  });
  const attachment = await withPhase(input.log, "Connecting Linq credentials...", () =>
    replaceConnectTrigger({
      connectorUid: connector.uid,
      projectRoot: input.projectRoot,
      projectId: input.project.projectId,
      orgId: input.project.orgId,
      environment: "production",
      triggerPath: LINQ_TRIGGER_PATH,
      onOutput,
      signal: input.signal,
      deps,
    }),
  );
  if (attachment.state !== "attached") {
    throw new Error(
      `Linq connector was created, but its trigger could not be attached. Run \`vercel connect attach ${connector.uid} --project ${input.project.projectId} --environment production --triggers --trigger-path ${LINQ_TRIGGER_PATH} --yes --scope ${input.project.orgId}\`.`,
    );
  }
  return connector;
}

/** Reads managed connector data after browser creation so setup can show its line. */
async function readLinqConnector(input: {
  connector: LinqConnectorRef;
  projectRoot: string;
  orgId: string;
  signal?: AbortSignal;
  deps: ProvisionLinqConnectorDeps;
}): Promise<LinqConnectorRef> {
  const result = await input.deps.runVercelCaptureStdout(
    [
      "api",
      `/v1/connect/connectors/${encodeURIComponent(input.connector.id)}`,
      "--scope",
      input.orgId,
    ],
    { cwd: input.projectRoot, nonInteractive: true, signal: input.signal },
  );
  if (!result.ok) return input.connector;
  const connector = parseCreatedLinqConnector(result.stdout);
  if (connector?.phoneNumber === undefined) return input.connector;
  return { ...input.connector, phoneNumber: connector.phoneNumber };
}
