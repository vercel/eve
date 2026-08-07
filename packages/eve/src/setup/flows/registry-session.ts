import type { Prompter } from "#setup/prompter.js";
import { openUrl } from "#setup/primitives/open-url.js";
import { detectDeployment } from "#setup/project-resolution.js";
import {
  emptyRegistrySetupCompletion,
  mergeRegistrySetupCompletions,
  registrySetupCompletionFacts,
} from "#setup/registry-setup-completion.js";
import type {
  RegistrySetupCompletion,
  RegistrySetupDestination,
  RegistrySetupFact,
} from "#setup/registry-setup-protocol.js";

import { runDeployFlow } from "./deploy.js";

export interface RegistrySessionDeps {
  detectDeployment: typeof detectDeployment;
  openUrl: typeof openUrl;
  runDeployFlow: typeof runDeployFlow;
}

export interface RegistrySessionResult {
  kind: "done";
  addedItems: readonly string[];
  facts: readonly RegistrySetupFact[];
  output: readonly string[];
  deployed?: "production" | "preview";
}

export interface RegistrySession {
  add(item: string, output: readonly string[], setup?: RegistrySetupCompletion): void;
  result(deployed?: "production" | "preview"): RegistrySessionResult;
  continueAfterInstall(input: {
    appRoot: string;
    prompter: Prompter;
    signal?: AbortSignal;
  }): Promise<"add-more" | RegistrySessionResult>;
}

/** Owns the accumulated output and deployment decision for one `/add` session. */
export function createRegistrySession(deps: RegistrySessionDeps): RegistrySession {
  const addedItems: string[] = [];
  const output: string[] = [];
  let completion = emptyRegistrySetupCompletion();

  function result(deployed?: "production" | "preview"): RegistrySessionResult {
    const session: RegistrySessionResult = {
      kind: "done",
      addedItems,
      facts: registrySetupCompletionFacts(completion),
      output,
    };
    if (deployed !== undefined) session.deployed = deployed;
    return session;
  }

  return {
    add(item, itemOutput, setup = emptyRegistrySetupCompletion()) {
      addedItems.push(item);
      output.push(...itemOutput);
      completion = mergeRegistrySetupCompletions(completion, setup);
    },

    result,

    async continueAfterInstall(input) {
      if (completion.deployment === undefined) return result();

      const deployment = await deps.detectDeployment(input.appRoot, { signal: input.signal });
      const canDeploy = deployment.state === "linked" || deployment.state === "deployed";
      const action = await input.prompter.select<"production" | "preview" | "add-more" | "finish">({
        message: "What would you like to do next?",
        options: [
          ...(canDeploy
            ? [
                { value: "production" as const, label: "Deploy to production" },
                { value: "preview" as const, label: "Deploy a preview" },
              ]
            : []),
          { value: "add-more", label: "Add another integration" },
          { value: "finish", label: "Finish without deploying" },
        ],
      });
      if (action === "add-more") return "add-more";
      if (action === "finish") return result();

      const deployResult = await deps.runDeployFlow({
        appRoot: input.appRoot,
        prompter: input.prompter,
        signal: input.signal,
        interactive: true,
        target: action,
      });
      const deployed = deployResult.kind === "deployed" ? action : undefined;
      if (deployed === "production") {
        await offerProductionDestination(
          input.prompter,
          deps.openUrl,
          completion.deployment.productionDestinations ?? [],
        );
      }
      return result(deployed);
    },
  };
}

async function offerProductionDestination(
  prompter: Prompter,
  open: typeof openUrl,
  destinations: readonly RegistrySetupDestination[],
): Promise<void> {
  if (destinations.length === 0) return;
  const destination = await prompter.select<string>({
    message: "Open a destination?",
    options: [
      ...destinations.map((candidate, index) => ({
        value: String(index),
        label: candidate.label,
        hint: candidate.url,
      })),
      { value: "none", label: "Not now" },
    ],
    initialValue: "none",
  });
  if (destination === "none") return;
  const selected = destinations[Number(destination)];
  if (selected !== undefined) open(selected.url);
}
