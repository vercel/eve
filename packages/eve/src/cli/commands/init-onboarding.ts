import { TerminalRenderer } from "#cli/dev/tui/terminal-renderer.js";
import { createTuiPrompter } from "#cli/dev/tui/tui-prompter.js";
import { runTuiSetupCommand } from "#cli/dev/tui/setup-commands.js";
import { planProviderChoice } from "#setup/flows/provider.js";
import { planRegistryFlow } from "#setup/flows/registry.js";
import {
  packageManagerInstallSucceeded,
  type PackageManagerInstallResult,
} from "#setup/primitives/index.js";

export interface InitOnboardingDeps {
  createRenderer(): Pick<TerminalRenderer, "renderCommandResult" | "setupFlow" | "shutdown">;
  planProviderChoice: typeof planProviderChoice;
  planRegistryFlow: typeof planRegistryFlow;
  runTuiSetupCommand: typeof runTuiSetupCommand;
}

const defaultDependencies: InitOnboardingDeps = {
  createRenderer: () => new TerminalRenderer({ logs: "stderr" }),
  planProviderChoice,
  planRegistryFlow,
  runTuiSetupCommand,
};

const ONBOARDING_STEPS = ["Model", "Channels", "Integrations", "Review"] as const;

function navigation(activeStep: number) {
  return {
    kind: "planner" as const,
    activeStep,
    firstNavigableStep: 1,
    steps: ONBOARDING_STEPS.map((label, index) => ({
      label,
      complete: index < activeStep,
    })),
  };
}

/** Collects fresh-project choices while install runs, then applies them after it succeeds. */
export async function runInitOnboarding(input: {
  appRoot: string;
  install: Promise<PackageManagerInstallResult>;
  afterInstall?: () => Promise<void>;
  deps?: Partial<InitOnboardingDeps>;
}): Promise<{ install: PackageManagerInstallResult; onboarded: boolean }> {
  const deps: InitOnboardingDeps = { ...defaultDependencies, ...input.deps };
  const renderer = deps.createRenderer();
  const flow = renderer.setupFlow;
  const prompter = createTuiPrompter(flow);
  const results: Array<{ message: string; tone?: "success" | "error" }> = [];
  let ready: Promise<PackageManagerInstallResult> | undefined;
  const settleInstall = () =>
    (ready ??= input.install.then(async (install) => {
      if (packageManagerInstallSucceeded(install)) await input.afterInstall?.();
      return install;
    }));
  try {
    flow.begin("Set up your agent", "pulse");
    flow.setNavigation?.(navigation(0));
    const provider = await deps.planProviderChoice({
      picker: (request) => flow.readProviderPicker(request),
      selectedProvider: "ai-gateway-project",
      selectionExplicit: false,
    });
    if (provider === undefined) return { install: await settleInstall(), onboarded: true };

    const registry = await deps.planRegistryFlow({
      appRoot: input.appRoot,
      prompter,
      plannerContext: {
        prefixSteps: [{ label: "Model", complete: true }],
        reviewMessage: "Review your agent",
        primaryActionLabel: "Install and finish setup",
        emptyActionLabel: "Finish setup",
      },
    });
    flow.setStatus("Preparing project");
    const install = await settleInstall();
    if (!packageManagerInstallSucceeded(install)) return { install, onboarded: false };
    if (registry.kind === "cancelled") return { install, onboarded: true };

    const model = await deps.runTuiSetupCommand({
      appRoot: input.appRoot,
      command: "model",
      initialModelStep: "provider",
      initialProviderChoice: provider,
      renderer: flow,
    });
    if (model.message !== "") results.push({ message: model.message, tone: model.tone });
    if (model.tone === "error" || model.cancelled === true) {
      return { install, onboarded: true };
    }

    const registryResult = await deps.runTuiSetupCommand({
      appRoot: input.appRoot,
      command: "add",
      initialRegistryItems: registry.items,
      renderer: flow,
    });
    if (registryResult.message !== "") {
      results.push({ message: registryResult.message, tone: registryResult.tone });
    }
    return { install, onboarded: true };
  } catch (error) {
    const settled = await settleInstall();
    if (!packageManagerInstallSucceeded(settled)) return { install: settled, onboarded: false };
    flow.renderLine(
      `Setup couldn't continue: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return { install: settled, onboarded: true };
  } finally {
    flow.setStatus(undefined);
    flow.end({ preserveDiagnostics: true });
    for (const result of results) renderer.renderCommandResult(result.message, result.tone);
    renderer.shutdown({ partingLine: false });
  }
}
