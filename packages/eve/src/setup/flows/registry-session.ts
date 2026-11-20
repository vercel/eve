import type { SetupPrerequisite } from "#setup/integrations/shared/prerequisite.js";
import type { Prompter } from "#setup/prompter.js";
import { detectDeployment } from "#setup/project-resolution.js";
import type { RegistrySetupCompletion, RegistrySetupFact } from "#setup/registry-setup-protocol.js";

import { runDeployFlow } from "./deploy.js";

interface RegistrySessionDeps {
  detectDeployment: typeof detectDeployment;
  runDeployFlow: typeof runDeployFlow;
}

export type RegistrySessionOutcome =
  | {
      kind: "installed";
      title: string;
      facts: readonly RegistrySetupFact[];
      output: readonly string[];
    }
  | {
      kind: "incomplete";
      title: string;
      address: string;
      resumeCommand: string;
      reason?: string;
      prerequisite?: SetupPrerequisite;
    }
  | { kind: "failed"; title: string; message: string }
  | { kind: "cancelled"; title: string };

export interface RegistrySessionResult {
  outcomes: readonly RegistrySessionOutcome[];
  cancelled?: true;
  deployed?: "production";
}

interface RegistrySession {
  add(title: string, output: readonly string[], setup?: RegistrySetupCompletion): void;
  addIncomplete(
    title: string,
    incomplete: Omit<Extract<RegistrySessionOutcome, { kind: "incomplete" }>, "kind" | "title">,
  ): void;
  addFailure(title: string, message: string): void;
  addCancellation(title: string): void;
  result(deployed?: "production"): RegistrySessionResult;
  continueAfterInstall(input: {
    appRoot: string;
    prompter: Prompter;
    signal?: AbortSignal;
  }): Promise<RegistrySessionResult>;
}

export function createRegistrySession(deps: RegistrySessionDeps): RegistrySession {
  const outcomes: RegistrySessionOutcome[] = [];
  let deploymentRequired = false;

  function result(deployed?: "production"): RegistrySessionResult {
    const session: RegistrySessionResult = { outcomes: [...outcomes] };
    if (deployed !== undefined) session.deployed = deployed;
    return session;
  }

  return {
    add(title, itemOutput, setup = { facts: [] }) {
      outcomes.push({ kind: "installed", title, facts: setup.facts, output: itemOutput });
      deploymentRequired ||= setup.deploymentRequired === true;
    },

    addIncomplete(title, incomplete) {
      outcomes.push({ kind: "incomplete", title, ...incomplete });
    },

    addFailure(title, message) {
      outcomes.push({ kind: "failed", title, message });
    },

    addCancellation(title) {
      outcomes.push({ kind: "cancelled", title });
    },

    result,

    async continueAfterInstall(input) {
      if (!deploymentRequired) return result();

      const deployment = await deps.detectDeployment(input.appRoot, { signal: input.signal });
      const canDeploy = deployment.state === "linked" || deployment.state === "deployed";
      input.prompter.replaceContent?.();
      while (true) {
        const action = await input.prompter.select<"deploy" | "finish">({
          message: "What would you like to do next?",
          initialValue: "finish",
          hintLayout: "inline",
          options: [
            ...(canDeploy ? [{ value: "deploy" as const, label: "Deploy" }] : []),
            { value: "finish", label: "Start chatting" },
          ],
        });
        if (action === "finish") return result();

        const confirmed = await input.prompter.select<"yes" | "back">({
          message: "Deploy to prod?",
          initialValue: "yes",
          options: [
            { value: "yes", label: "Yes" },
            { value: "back", label: "Back" },
          ],
        });
        if (confirmed === "back") continue;

        const deployResult = await deps.runDeployFlow({
          appRoot: input.appRoot,
          prompter: input.prompter,
          signal: input.signal,
          interactive: true,
        });
        return result(deployResult.kind === "deployed" ? "production" : undefined);
      }
    },
  };
}
