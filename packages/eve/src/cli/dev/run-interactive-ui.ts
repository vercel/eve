import { randomUUID } from "node:crypto";

import { devBootPhase, type DevBootProgressReporter } from "#internal/dev-boot-progress.js";
import { findEveProjectContext } from "#internal/project-context.js";
import {
  resumeDevelopmentRuntimeArtifacts,
  suspendDevelopmentRuntimeArtifacts,
} from "#services/dev-client/runtime-artifacts.js";

import type { EveCliOnboardingStage } from "#cli/telemetry/index.js";

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
  readonly onOnboardingStage?: (stage: EveCliOnboardingStage) => void;
  readonly server: { readonly appRoot?: string; readonly serverUrl: string };
  readonly startup?: DevelopmentTuiStartup;
}): Promise<void> {
  const runDevelopmentTui = await devBootPhase(
    "loading interactive UI",
    async () => input.runDevelopmentTui ?? (await import("#cli/dev/tui/tui.js")).runDevelopmentTui,
    input.report,
  );
  const applicationRoot = input.server.appRoot ?? input.applicationRoot;
  const projectContext = await findEveProjectContext(applicationRoot);
  const workspaceRoot = projectContext?.environmentRoot ?? applicationRoot;
  const agentRoot =
    projectContext?.kind === "workspace-member" ? projectContext.member.appRoot : undefined;
  const target =
    input.remoteTarget === undefined || input.existingLocalServer
      ? { kind: "local" as const, serverUrl: input.server.serverUrl, workspaceRoot, agentRoot }
      : { kind: "remote" as const, serverUrl: input.server.serverUrl, workspaceRoot, agentRoot };
  const display = resolveTuiDisplayOptions(input.options);
  const name = resolveTuiTitle({ name: input.options.name, target });
  if (name !== undefined) display.name = name;

  const tuiInput: RunDevelopmentTuiInput = {
    target,
    initialInput: input.options.input,
    onboard: input.options.onboard,
    onBootProgress: input.report,
    onOnboardingStage: input.onOnboardingStage,
    lifecycle: input.lifecycle,
    ...display,
  };
  if (input.startup !== undefined) tuiInput.startup = input.startup;
  if (target.kind === "local") {
    tuiInput.withExclusiveTerminal = async <T>(task: () => Promise<T>): Promise<T> => {
      const leaseId = randomUUID();
      if (
        !(await suspendDevelopmentRuntimeArtifacts({
          leaseId,
          serverUrl: input.server.serverUrl,
        }))
      ) {
        throw new Error("Could not pause the development server for integration setup.");
      }
      let outcome:
        | { readonly error: unknown; readonly ok: false }
        | { readonly ok: true; value: T };
      try {
        outcome = { ok: true, value: await task() };
      } catch (error) {
        outcome = { error, ok: false };
      }

      const release = {
        leaseId,
        serverUrl: input.server.serverUrl,
        silent: true,
      } as const;
      if (
        (await resumeDevelopmentRuntimeArtifacts(release)) === undefined &&
        (await resumeDevelopmentRuntimeArtifacts(release)) === undefined
      ) {
        throw new Error(
          "Could not resume the eve development server after integration setup. Restart eve dev before making further source changes.",
          outcome.ok ? undefined : { cause: outcome.error },
        );
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    };
  }

  if (input.remoteTarget?.headers === undefined) {
    await runDevelopmentTui(tuiInput);
  } else {
    await runDevelopmentTui({ ...tuiInput, headers: input.remoteTarget.headers });
  }
}
