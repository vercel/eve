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
  /** Files were added, but the item's setup was cancelled or skipped. */
  | { kind: "incomplete"; title: string; resumeCommand: string }
  /** User-facing installation error, including any actionable follow-up lines. */
  | { kind: "failed"; title: string; message: string }
  /** Stopped before anything was written. */
  | { kind: "cancelled"; title: string };

export interface RegistrySessionResult {
  /** Every item outcome in installation order. */
  outcomes: readonly RegistrySessionOutcome[];
  /** Setup stopped outside an individual item after preserving settled results. */
  cancelled?: true;
  deployed?: "production";
}

interface RegistrySession {
  add(title: string, output: readonly string[], setup?: RegistrySetupCompletion): void;
  addIncomplete(title: string, resumeCommand: string): void;
  addFailure(title: string, message: string): void;
  addCancellation(title: string): void;
  result(deployed?: "production"): RegistrySessionResult;
  continueAfterInstall(input: {
    appRoot: string;
    prompter: Prompter;
    signal?: AbortSignal;
  }): Promise<RegistrySessionResult>;
}

/** Owns the accumulated output and deployment decision for one `/add` session. */
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

    addIncomplete(title, resumeCommand) {
      outcomes.push({ kind: "incomplete", title, resumeCommand });
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
