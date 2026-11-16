import type { ChannelSetupLog } from "#setup/cli/index.js";
import { createPromptCommandOutput, withPhase } from "#setup/cli/index.js";
import { replaceConnectTrigger } from "#setup/connect-provisioning.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import {
  runVercel,
  runVercelCaptureStdout,
  type RunVercelCaptureResult,
} from "#setup/primitives/run-vercel.js";
import { z } from "#compiled/zod/index.js";

const TELEGRAM_TRIGGER_PATH = "/eve/v1/telegram";

interface TelegramConnectorRef {
  id: string;
  uid: string;
}

interface ProvisionTelegramConnectorDeps {
  runVercel: typeof runVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

const ConnectorSchema = z.object({ id: z.string().min(1), uid: z.string().min(1) });

/** Parses Vercel Connect JSON for a created Telegram connector. */
export function parseCreatedTelegramConnector(stdout: string): TelegramConnectorRef | undefined {
  try {
    const result = ConnectorSchema.safeParse(JSON.parse(stdout));
    return result.success ? { id: result.data.id, uid: result.data.uid } : undefined;
  } catch {
    return undefined;
  }
}

function requireCreatedConnector(result: RunVercelCaptureResult): TelegramConnectorRef {
  if (!result.ok) {
    const detail = [result.stderr, result.stdout].find(
      (value): value is string => value !== undefined && value.trim().length > 0,
    );
    throw new Error(
      detail
        ? `Telegram connector creation failed:\n${detail}`
        : "Telegram connector creation failed.",
    );
  }
  const connector = parseCreatedTelegramConnector(result.stdout);
  if (connector === undefined) throw new Error("Vercel returned an invalid Telegram connector.");
  return connector;
}

/**
 * Stores the bot token in a Telegram connector and routes its triggers to eve.
 * Connect registers the bot's webhook and verifies Telegram's secret token.
 */
export async function provisionTelegramConnector(input: {
  botToken: string;
  log: ChannelSetupLog;
  project: VercelProjectReference;
  projectRoot: string;
  slug: string;
  signal?: AbortSignal;
  deps?: ProvisionTelegramConnectorDeps;
}): Promise<TelegramConnectorRef> {
  const deps = input.deps ?? { runVercel, runVercelCaptureStdout };
  const onOutput = createPromptCommandOutput(input.log);
  const result = await withPhase(input.log, "Creating Telegram connector...", () =>
    deps.runVercelCaptureStdout(
      [
        "connect",
        "create",
        "telegram",
        "--name",
        input.slug,
        "--connection-method",
        "api-key",
        "--data",
        "@-",
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
        // Pass the token on stdin so it never appears in argv or shell history.
        stdin: JSON.stringify({ values: [{ value: input.botToken }] }),
      },
    ),
  );
  input.signal?.throwIfAborted();
  const connector = requireCreatedConnector(result);
  const attachment = await withPhase(input.log, "Routing Telegram updates to eve...", () =>
    replaceConnectTrigger({
      connectorUid: connector.uid,
      projectRoot: input.projectRoot,
      projectId: input.project.projectId,
      orgId: input.project.orgId,
      environment: "production",
      triggerPath: TELEGRAM_TRIGGER_PATH,
      onOutput,
      signal: input.signal,
      deps,
    }),
  );
  input.signal?.throwIfAborted();
  if (attachment.state !== "attached") {
    const attach = `vercel connect attach ${connector.uid} --project ${input.project.projectId} --environment production --triggers --trigger-path ${TELEGRAM_TRIGGER_PATH} --yes --scope ${input.project.orgId}`;
    throw new Error(
      attachment.state === "detach-failed"
        ? `Telegram connector was created, but its default trigger destination could not be removed. Run \`vercel connect detach ${connector.uid} --project ${input.project.projectId} --yes --scope ${input.project.orgId}\`, then \`${attach}\`.`
        : `Telegram connector was created, but its trigger could not be attached. Run \`${attach}\`.`,
    );
  }
  return connector;
}
