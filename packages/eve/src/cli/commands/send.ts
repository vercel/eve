import {
  renderFetches,
  renderTurnPreviewInstructions,
  renderTurnPreviewRows,
} from "#cli/commands/turn-preview-rows.js";
import { installShutdownSignal } from "#cli/shutdown.js";
import { createCliTheme, renderCliSection } from "#cli/ui/output.js";
import type { DevelopmentServer, DevelopmentServerOptions } from "#internal/nitro/host/types.js";

interface SendCommandLogger {
  log(message: string): void;
}

export interface SendOptions {
  readonly as?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

export interface SendJson {
  readonly reply: string;
  readonly sessionId: string;
  readonly url: string;
}

type StartHost = (appRoot: string, options?: DevelopmentServerOptions) => DevelopmentServer;

export async function runSendCommand(
  logger: SendCommandLogger,
  appRoot: string,
  message: string,
  options: SendOptions,
  startHost?: StartHost,
): Promise<void> {
  if (message.trim() === "") throw new Error("eve send needs a message.");
  if (options.dryRun === true) {
    const [{ dryRunSend }, { parsePreviewPrincipal }] = await Promise.all([
      import("#services/dry-run.js"),
      import("#services/turn-preview.js"),
    ]);
    const result = await dryRunSend({
      appRoot,
      message,
      principal: parsePreviewPrincipal(options.as ?? "local-dev"),
    });
    if (options.json === true) {
      logger.log(JSON.stringify(result, null, 2));
      return;
    }
    const theme = createCliTheme();
    logger.log(
      [
        renderCliSection(theme, {
          rows: [
            { label: "Mode", value: "dry run: no session started, no model call" },
            { label: "Message", value: message },
            ...renderTurnPreviewRows(result.turn),
          ],
          title: "Turn",
        }),
        renderCliSection(theme, {
          rows: [
            { label: "Instructions", value: renderTurnPreviewInstructions(result.turn) || "none" },
          ],
          title: "Instructions",
        }),
        renderFetches(result.fetches),
      ].join("\n\n"),
    );
    return;
  }
  if (options.as !== undefined) {
    throw new Error(
      "--as needs --dry-run. A real send authenticates like any other caller of the dev server.",
    );
  }

  const [{ loadDevelopmentEnvironmentFiles }, { runRemotePrint }, { findEveProjectContext }] =
    await Promise.all([
      import("#cli/dev/environment.js"),
      import("#cli/dev/remote-print.js"),
      import("#internal/project-context.js"),
    ]);
  await loadDevelopmentEnvironmentFiles(appRoot);
  const create =
    startHost ?? (await import("#cli/dev/local-server-process.js")).createDevelopmentServer;
  const server = create(appRoot, { existing: "attach-if-unconfigured", output: "stderr" });
  const lifecycle = installShutdownSignal();
  try {
    const handle = await server.start();
    const projectContext = await findEveProjectContext(appRoot);
    const { reply, sessionId } = await runRemotePrint({
      prompt: message,
      serverUrl: handle.url,
      signal: lifecycle.signal,
      workspaceRoot: projectContext?.environmentRoot ?? appRoot,
    });
    const result: SendJson = { reply, sessionId, url: handle.url };
    logger.log(options.json === true ? JSON.stringify(result, null, 2) : reply);
  } finally {
    lifecycle.dispose();
    await server.close();
  }
}
