import { detectPackageManager } from "#setup/package-manager.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";

import type { RegistryCommandLogger } from "./registry-recovery.js";
import {
  applyPnpmBuildPolicy,
  inspectPnpmBuildPolicy,
  type PnpmBuildPolicyAction,
  type PnpmBuildPolicyContext,
} from "./registry-pnpm-build-policy.js";
import { headlessSetupContinuation, serializeHeadlessSetupEvent } from "./setup-headless.js";

const PNPM_BUILD_POLICY_ANSWER_KEY = "install.pnpm.buildScripts";
type PnpmBuildPolicyChoice = PnpmBuildPolicyAction | "abort";

export interface DeclaredPnpmBuildPolicy {
  readonly packages: readonly string[];
  readonly optional: true;
  readonly recommendedAction: "ignore-optional";
  readonly reason: string;
}

interface PnpmBuildPolicyFlowDependencies {
  readonly detectPackageManager: typeof detectPackageManager;
  readonly inspectPnpmBuildPolicy: typeof inspectPnpmBuildPolicy;
  readonly applyPnpmBuildPolicy: typeof applyPnpmBuildPolicy;
  readonly createPrompter: () => Prompter;
}

function pnpmBuildPolicyChoice(value: unknown): PnpmBuildPolicyChoice | undefined {
  return value === "ignore-optional" || value === "allow-builds" || value === "abort"
    ? value
    : undefined;
}

/** Resolves declared pnpm build-script decisions before registry installation begins. */
export async function prepareDeclaredPnpmBuildPolicy(
  input: {
    readonly logger: RegistryCommandLogger;
    readonly appRoot: string;
    readonly item: string;
    readonly policies: readonly DeclaredPnpmBuildPolicy[] | undefined;
    readonly options: {
      readonly yes?: boolean;
      readonly nonInteractive?: boolean;
      readonly answers?: Readonly<Record<string, unknown>>;
      readonly prompter?: Prompter;
    };
  },
  dependencyOverrides: Partial<PnpmBuildPolicyFlowDependencies> = {},
): Promise<boolean> {
  if (input.policies === undefined || input.policies.length === 0) return true;
  const dependencies: PnpmBuildPolicyFlowDependencies = {
    detectPackageManager: dependencyOverrides.detectPackageManager ?? detectPackageManager,
    inspectPnpmBuildPolicy: dependencyOverrides.inspectPnpmBuildPolicy ?? inspectPnpmBuildPolicy,
    applyPnpmBuildPolicy: dependencyOverrides.applyPnpmBuildPolicy ?? applyPnpmBuildPolicy,
    createPrompter: dependencyOverrides.createPrompter ?? createPrompter,
  };
  if ((await dependencies.detectPackageManager(input.appRoot)).kind !== "pnpm") return true;

  for (const policy of input.policies) {
    const context: PnpmBuildPolicyContext = await dependencies.inspectPnpmBuildPolicy(
      input.appRoot,
      policy.packages,
    );
    if (context.satisfied) continue;

    const suppliedAnswer = input.options.answers?.[PNPM_BUILD_POLICY_ANSWER_KEY];
    let choice = pnpmBuildPolicyChoice(suppliedAnswer);
    if (suppliedAnswer !== undefined && choice === undefined) {
      throw new Error(
        `${PNPM_BUILD_POLICY_ANSWER_KEY} must be "ignore-optional", "allow-builds", or "abort".`,
      );
    }
    if (input.options.nonInteractive && choice === undefined && input.options.yes !== true) {
      const question = {
        key: PNPM_BUILD_POLICY_ANSWER_KEY,
        kind: "select" as const,
        message: "How should pnpm handle these optional packages?",
        required: true,
        recommended: policy.recommendedAction,
        options: [
          { id: "ignore-optional", label: "Ignore optional packages" },
          { id: "allow-builds", label: "Allow build scripts" },
          { id: "abort", label: "Abort add" },
        ],
      };
      input.logger.error(
        serializeHeadlessSetupEvent({
          version: 1,
          type: "blocked",
          item: input.item,
          installed: false,
          completedItems: [],
          status: "input_required",
          question,
          next: headlessSetupContinuation({ item: input.item, installed: false, question }),
        }),
      );
      process.exitCode = 2;
      return false;
    }
    if (choice === undefined && input.options.yes === true) choice = policy.recommendedAction;
    if (choice === undefined) {
      const prompter = input.options.prompter ?? dependencies.createPrompter();
      try {
        choice = await prompter.select<PnpmBuildPolicyChoice>({
          message: "How should pnpm handle these optional packages?",
          description: policy.reason,
          metadata: [
            { label: "Packages", value: policy.packages.join(", ") },
            { label: "Policy file", value: context.filePath },
          ],
          hintLayout: "stacked",
          initialValue: policy.recommendedAction,
          options: [
            {
              value: "ignore-optional",
              label: "Ignore optional packages (recommended)",
              hint: "Add the item without installing these packages or running their build scripts.",
            },
            {
              value: "allow-builds",
              label: "Allow build scripts",
              hint: "Install these packages and allow their third-party build scripts to run.",
            },
            {
              value: "abort",
              label: "Abort add",
              hint: "Do not add this registry item.",
            },
          ],
        });
      } catch (error) {
        if (!(error instanceof WizardCancelledError)) throw error;
        return false;
      }
    }
    if (choice === "abort") {
      if (input.options.nonInteractive) {
        input.logger.log(
          serializeHeadlessSetupEvent({
            version: 1,
            type: "cancelled",
            item: input.item,
            completedItems: [],
          }),
        );
      }
      return false;
    }
    if (choice === undefined) throw new Error("pnpm build policy selection is required.");
    await dependencies.applyPnpmBuildPolicy(context, choice);
  }
  return true;
}
