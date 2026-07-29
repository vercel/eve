import { Command } from "#compiled/commander/index.js";
import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import {
  parseDevelopmentHeaderOption,
  resolveDevelopmentUrlTarget,
  type DevelopmentRequestHeaders,
} from "#cli/dev/url-target.js";
import { parseDevelopmentServerUrl } from "#cli/dev/url.js";
import { FORCED_EXIT_BACKSTOP_MS, installShutdownSignal } from "#cli/shutdown.js";
import type { DevelopmentServer, DevelopmentServerOptions } from "#internal/nitro/host/types.js";

export type RunAcpServer = (input: {
  readonly appRoot: string;
  readonly eveVersion: string;
  readonly headers?: DevelopmentRequestHeaders;
  readonly serverUrl: string;
  readonly signal?: AbortSignal;
  readonly validateWorkspaceRoot: boolean;
}) => Promise<void>;

export interface RegisterAcpCommandOptions {
  readonly appRoot: string;
  readonly eveVersion: string;
  readonly program: Command;
  readonly runAcpServer?: RunAcpServer;
  readonly startHost?: (appRoot: string, options?: DevelopmentServerOptions) => DevelopmentServer;
}

/** Registers the ACP stdio bridge for local and deployed eve agents. */
export function registerAcpCommand(options: RegisterAcpCommandOptions): void {
  options.program
    .command("acp")
    .description("Serve an eve agent through stable ACP v1 over stdio.")
    .argument("[url]", "Connect to an existing server URL", parseDevelopmentServerUrl)
    .option("-u, --url <url>", "Connect to an existing server URL", parseDevelopmentServerUrl)
    .option(
      "-H, --header <header>",
      'Request header for a URL target, in "Name: value" form (repeatable)',
      parseDevelopmentHeaderOption,
    )
    .addHelpText(
      "after",
      "\nWithout a URL, eve supervises a local development server. You can also pass a bare URL, for example: eve acp https://example.com\n",
    )
    .action(async (positionalUrl: string | undefined, commandOptions: AcpCliOptions) => {
      const target = resolveDevelopmentUrlTarget(commandOptions, positionalUrl);
      loadDevelopmentEnvironmentFiles(options.appRoot);
      const lifecycle = installShutdownSignal({ exitAfterMs: FORCED_EXIT_BACKSTOP_MS });

      if (target !== undefined) {
        try {
          await runAcp(options, {
            appRoot: options.appRoot,
            headers: target.headers,
            serverUrl: target.serverUrl,
            signal: lifecycle.signal,
            validateWorkspaceRoot: false,
          });
        } finally {
          lifecycle.dispose();
        }
        return;
      }

      let server: DevelopmentServer | undefined;
      let closePromise: Promise<void> | undefined;
      const closeServer = () => {
        if (server === undefined) return Promise.resolve();
        closePromise ??= server.close();
        void closePromise.catch(() => undefined);
        return closePromise;
      };
      lifecycle.signal.addEventListener("abort", () => void closeServer(), { once: true });

      try {
        const startHost = options.startHost ?? (await loadStartHost());
        server = startHost(options.appRoot, {
          existing: "reject",
          host: "127.0.0.1",
          output: "stderr",
          port: 0,
        });
        const handle = await Promise.race([
          server.start(),
          lifecycle.stopped.then(() => undefined),
        ]);
        if (handle === undefined) return;

        await runAcp(options, {
          appRoot: handle.appRoot,
          serverUrl: handle.url,
          signal: lifecycle.signal,
          validateWorkspaceRoot: true,
        });
        lifecycle.requestStop();
      } finally {
        await closeServer();
        lifecycle.dispose();
      }
    });
}

interface AcpCliOptions {
  readonly header?: DevelopmentRequestHeaders;
  readonly url?: string;
}

async function runAcp(
  options: RegisterAcpCommandOptions,
  input: Omit<Parameters<RunAcpServer>[0], "eveVersion">,
): Promise<void> {
  const run = options.runAcpServer ?? (await import("#acp/server.js")).runAcpServer;
  await run({ eveVersion: options.eveVersion, ...input });
}

async function loadStartHost(): Promise<NonNullable<RegisterAcpCommandOptions["startHost"]>> {
  return (await import("#cli/dev/local-server-process.js")).createDevelopmentServer;
}
