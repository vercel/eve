import { resolve } from "node:path";

import type { Command } from "#compiled/commander/index.js";
import { applicationCommand, type CliApplicationContext } from "#cli/application-command.js";
import { resolveInternalVercelServiceOutput } from "#cli/vercel-service-output.js";
import { createCliTheme, renderCliTaggedLine } from "#cli/ui/output.js";
import type { ApplicationBuildOptions } from "#internal/nitro/host/types.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";

export type BuildHost = (appRoot: string, options: ApplicationBuildOptions) => Promise<string>;

interface BuildCommandLogger {
  log(message: string): void;
}

interface BuildCliOptions {
  profile?: string;
  skipSandboxPrewarm?: boolean;
}

/** Registers the production application build command. */
export function registerBuildCommand(input: {
  readonly application: CliApplicationContext;
  readonly buildHost?: BuildHost;
  readonly logger: BuildCommandLogger;
  readonly program: Command;
}): void {
  const theme = createCliTheme();

  applicationCommand(input.program.command("build"))
    .description("Build the current eve application.")
    .option("--profile <path>", "Write best-effort timing and output-size profile JSON to a file")
    .option(
      "--skip-sandbox-prewarm",
      "Skip sandbox template prewarm for a Vercel build; output may not be deployable",
    )
    .action(async (options: BuildCliOptions) => {
      const { loadDevelopmentEnvironmentFiles } = await import("#cli/dev/environment.js");

      loadDevelopmentEnvironmentFiles(input.application.root);

      const buildHost =
        input.buildHost ?? (await import("#internal/nitro/host.js")).buildApplication;
      const profileOutputPath =
        options.profile === undefined
          ? undefined
          : resolve(input.application.root, options.profile);
      const buildOptions: {
        profileOutputPath?: string;
        readonly publicRoutePrefix: ApplicationBuildOptions["publicRoutePrefix"];
        readonly skipVercelSandboxPrewarm: boolean;
        readonly vercelServiceOutput: ApplicationBuildOptions["vercelServiceOutput"];
      } = {
        publicRoutePrefix: normalizePublicRoutePrefix(process.env[EVE_PUBLIC_ROUTE_PREFIX_ENV]),
        skipVercelSandboxPrewarm: options.skipSandboxPrewarm === true,
        vercelServiceOutput: resolveInternalVercelServiceOutput(input.application.root),
      };
      if (profileOutputPath !== undefined) {
        buildOptions.profileOutputPath = profileOutputPath;
      }
      const outputDir = await buildHost(input.application.root, buildOptions);
      input.logger.log(
        renderCliTaggedLine(theme, {
          message: `built output at ${outputDir}`,
          tag: "build",
          tone: "success",
        }),
      );
    });
}
