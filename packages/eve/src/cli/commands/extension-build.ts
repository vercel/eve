import pc from "picocolors";

import { createCliTheme, renderCliTaggedLine } from "#cli/ui/output.js";
import { createLogger } from "#internal/logging.js";
import {
  buildExtensionPackage,
  tryReadExtensionBuildConfig,
} from "#internal/nitro/host/build-extension.js";

export interface ExtensionBuildCliLogger {
  error(message: string): void;
  log(message: string): void;
}

const buildLog = createLogger("extension-build");

/**
 * Builds the current package as an eve extension. Requires
 * `package.json#eve.extension` pointing at the source root (e.g. `./extension`).
 */
export async function runExtensionBuildCommand(
  logger: ExtensionBuildCliLogger,
  appRoot: string,
): Promise<void> {
  const config = await tryReadExtensionBuildConfig(appRoot);
  if (config === null) {
    throw new Error(
      'This package is not an eve extension. Add `"eve": { "extension": "./extension" }` to package.json, ' +
        "or run `eve build` for an agent app.",
    );
  }

  buildLog.debug("building extension package", {
    packageName: config.packageName,
    sourceRoot: config.sourceRoot,
  });
  const outputDir = await buildExtensionPackage(appRoot, config);
  const theme = createCliTheme();
  logger.log(
    renderCliTaggedLine(theme, {
      message: `built extension ${pc.bold(config.packageName)} at ${outputDir}`,
      tag: "build",
      tone: "success",
    }),
  );
}
