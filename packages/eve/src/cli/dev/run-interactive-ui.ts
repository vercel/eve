import { devBootPhase, type DevBootProgressReporter } from "#internal/dev-boot-progress.js";
import {
  resumeDevelopmentRuntimeArtifacts,
  suspendDevelopmentRuntimeArtifacts,
} from "#services/dev-client/runtime-artifacts.js";

import type { DevelopmentCliOptions } from "./command-options.js";
import { resolveTuiDisplayOptions } from "./ui-options.js";
import type { DevelopmentTuiStartup, RunDevelopmentTuiInput } from "./tui/tui.js";
import { resolveTuiTitle } from "./tui/target.js";
import type { DevelopmentUrlTarget } from "./url-target.js";
import type { CommandLifecycle } from "../shutdown.js";

export async function runInteractiveDevelopmentUi(input: {
  readonly applicationRoot: string;
  readonly existingLocalServer: boolean;
  readonly lifecycle?: CommandLifecycle;
  readonly options: DevelopmentCliOptions;
  readonly remoteTarget?: DevelopmentUrlTarget;
  readonly report?: DevBootProgressReporter;
  readonly runDevelopmentTui?: (input: RunDevelopmentTuiInput) => Promise<void>;
  readonly server: { readonly appRoot?: string; readonly serverUrl: string };
  readonly startup?: DevelopmentTuiStartup;
}): Promise<void> {
  const runDevelopmentTui = await devBootPhase(
    "loading interactive UI",
    async () => input.runDevelopmentTui ?? (await import("#cli/dev/tui/tui.js")).runDevelopmentTui,
    input.report,
  );
  const target =
    input.remoteTarget === undefined || input.existingLocalServer
      ? {
          kind: "local" as const,
          serverUrl: input.server.serverUrl,
          workspaceRoot: input.server.appRoot ?? input.applicationRoot,
        }
      : {
          kind: "remote" as const,
          serverUrl: input.server.serverUrl,
          workspaceRoot: input.applicationRoot,
        };
  const display = resolveTuiDisplayOptions(input.options);
  const name = resolveTuiTitle({ name: input.options.name, target });
  if (name !== undefined) display.name = name;

  const tuiInput: RunDevelopmentTuiInput = {
    target,
    initialInput: input.options.input,
    onBootProgress: input.report,
    lifecycle: input.lifecycle,
    ...display,
  };
  if (input.startup !== undefined) tuiInput.startup = input.startup;
  if (target.kind === "local") {
    tuiInput.withExclusiveTerminal = async <T>(task: () => Promise<T>): Promise<T> => {
      if (!(await suspendDevelopmentRuntimeArtifacts({ serverUrl: input.server.serverUrl }))) {
        throw new Error("Could not pause the development server for integration setup.");
      }
      try {
        return await task();
      } finally {
        await resumeDevelopmentRuntimeArtifacts({
          serverUrl: input.server.serverUrl,
          silent: true,
        });
      }
    };
  }

  if (input.remoteTarget?.headers === undefined) {
    await runDevelopmentTui(tuiInput);
  } else {
    await runDevelopmentTui({ ...tuiInput, headers: input.remoteTarget.headers });
  }
}
