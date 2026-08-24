import type { Prompter } from "#setup/prompter.js";
import { detectDeployment } from "#setup/project-resolution.js";
import { mergeRegistrySetupCompletions } from "#setup/registry-setup-completion.js";
import type { RegistrySetupCompletion, RegistrySetupFact } from "#setup/registry-setup-protocol.js";
import { WizardCancelledError } from "#setup/step.js";

import { runDeployFlow } from "./deploy.js";

export interface RegistrySessionDeps {
  detectDeployment: typeof detectDeployment;
  runDeployFlow: typeof runDeployFlow;
}

export interface RegistrySessionItemResult {
  address: string;
  title: string;
  facts: readonly RegistrySetupFact[];
  output: readonly string[];
}

export interface RegistrySessionResult {
  kind: "done";
  addedItems: readonly string[];
  items: readonly RegistrySessionItemResult[];
  facts: readonly RegistrySetupFact[];
  output: readonly string[];
  deployed?: "production";
}

export interface RegistrySession {
  add(
    item: string,
    title: string,
    output: readonly string[],
    setup?: RegistrySetupCompletion,
  ): void;
  result(deployed?: "production"): RegistrySessionResult;
  continueAfterInstall(input: {
    appRoot: string;
    prompter: Prompter;
    signal?: AbortSignal;
  }): Promise<"add-more" | RegistrySessionResult>;
}

/** Owns the accumulated output and deployment decision for one `/add` session. */
export function createRegistrySession(deps: RegistrySessionDeps): RegistrySession {
  const addedItems: string[] = [];
  const items: RegistrySessionItemResult[] = [];
  const output: string[] = [];
  let completion: RegistrySetupCompletion = { facts: [] };
  let currentItem = "";
  let currentFacts: readonly RegistrySetupFact[] = [];

  function result(deployed?: "production"): RegistrySessionResult {
    const session: RegistrySessionResult = {
      kind: "done",
      addedItems,
      items,
      facts: completion.facts,
      output,
    };
    if (deployed !== undefined) session.deployed = deployed;
    return session;
  }

  return {
    add(item, title, itemOutput, setup = { facts: [] }) {
      addedItems.push(item);
      items.push({ address: item, title, facts: setup.facts, output: itemOutput });
      output.push(...itemOutput);
      currentItem = title;
      currentFacts = setup.facts;
      completion = mergeRegistrySetupCompletions(completion, setup);
    },

    result,

    async continueAfterInstall(input) {
      if (completion.deploymentRequired !== true) return result();

      const deployment = await deps.detectDeployment(input.appRoot, { signal: input.signal });
      const canDeploy = deployment.state === "linked" || deployment.state === "deployed";
      input.prompter.replaceContent?.({
        headline: `Added ${currentItem}`,
        facts: currentFacts,
      });
      while (true) {
        let action: "deploy" | "add-more" | "finish";
        try {
          action = await input.prompter.select<"deploy" | "add-more" | "finish">({
            message: "What would you like to do next?",
            initialValue: "add-more",
            hintLayout: "inline",
            options: [
              { value: "add-more", label: "Add more" },
              ...(canDeploy ? [{ value: "deploy" as const, label: "Deploy" }] : []),
              { value: "finish", label: "Finish" },
            ],
          });
        } catch (error) {
          if (!(error instanceof WizardCancelledError)) throw error;
          if (input.signal?.aborted) throw error;
          input.prompter.replaceContent?.();
          return "add-more";
        }
        if (action === "add-more") {
          input.prompter.replaceContent?.();
          return "add-more";
        }
        if (action === "finish") return result();

        let confirmed: "yes" | "back";
        try {
          confirmed = await input.prompter.select<"yes" | "back">({
            message: "Deploy to prod?",
            initialValue: "yes",
            options: [
              { value: "yes", label: "Yes" },
              { value: "back", label: "Back" },
            ],
          });
        } catch (error) {
          if (!(error instanceof WizardCancelledError)) throw error;
          if (input.signal?.aborted) throw error;
          continue;
        }
        if (confirmed === "back") continue;

        const deployResult = await deps.runDeployFlow({
          appRoot: input.appRoot,
          prompter: input.prompter,
          signal: input.signal,
          interactive: true,
        });
        if (deployResult.kind === "cancelled") {
          if (input.signal?.aborted) return result();
          continue;
        }
        return result(deployResult.kind === "deployed" ? "production" : undefined);
      }
    },
  };
}
