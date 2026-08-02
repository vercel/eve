import { createPromptCommandOutput, withPhase, type ChannelSetupLog } from "#setup/cli/index.js";
import { replaceConnectTrigger } from "#setup/connect-provisioning.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import { z } from "zod";

export const DISCORD_TRIGGER_PATH = "/eve/v1/discord";

export interface DiscordConnectorRef {
  id: string;
  uid: string;
}

export interface ProvisionDiscordConnectorDeps {
  runVercel: typeof runVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

const DiscordConnectorRefSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  supportedSubjectTypes: z.array(z.string()).refine((types) => types.includes("app")),
});

/** Parses `vercel connect create -F json` output for a Discord connector. */
export function parseCreatedDiscordConnector(stdout: string): DiscordConnectorRef | undefined {
  try {
    const parsed = DiscordConnectorRefSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? { id: parsed.data.id, uid: parsed.data.uid } : undefined;
  } catch {
    return undefined;
  }
}

/** Creates a Discord connector and attaches its trigger to eve's route. */
export async function provisionDiscordConnector(input: {
  botToken: string;
  log: ChannelSetupLog;
  project: VercelProjectReference;
  projectRoot: string;
  slug: string;
  signal?: AbortSignal;
  deps?: ProvisionDiscordConnectorDeps;
}): Promise<DiscordConnectorRef> {
  const deps = input.deps ?? { runVercel, runVercelCaptureStdout };
  const onOutput = createPromptCommandOutput(input.log);
  const result = await withPhase(input.log, "Creating Discord connector...", () =>
    deps.runVercelCaptureStdout(
      [
        "connect",
        "create",
        "discord",
        "--connector-type",
        "discord",
        "--data",
        "@-",
        "--name",
        input.slug,
        "--triggers",
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
        stdin: JSON.stringify({ botToken: input.botToken.trim() }),
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
        ? `Discord connector creation failed:\n${detail}`
        : "Discord connector creation failed.",
    );
  }
  const connector = parseCreatedDiscordConnector(result.stdout);
  if (connector === undefined) throw new Error("Vercel returned an invalid Discord connector.");

  const attachment = await withPhase(input.log, "Connecting Discord interactions...", () =>
    replaceConnectTrigger({
      connectorUid: connector.uid,
      projectRoot: input.projectRoot,
      projectId: input.project.projectId,
      orgId: input.project.orgId,
      environment: "production",
      triggerPath: DISCORD_TRIGGER_PATH,
      onOutput,
      signal: input.signal,
      deps,
    }),
  );
  if (attachment.state !== "attached") {
    throw new Error(
      `Discord connector was created, but its trigger could not be attached. Run \`vercel connect attach ${connector.uid} --project ${input.project.projectId} --environment production --triggers --trigger-path ${DISCORD_TRIGGER_PATH} --yes --scope ${input.project.orgId}\`.`,
    );
  }
  return connector;
}
