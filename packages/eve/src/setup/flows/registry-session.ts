import type { Prompter } from "#setup/prompter.js";
import { detectDeployment } from "#setup/project-resolution.js";
import type { RegistrySetupCompletion, RegistrySetupFact } from "#setup/registry-setup-protocol.js";

import { runDeployFlow } from "./deploy.js";

export interface RegistrySessionDeps {
  detectDeployment: typeof detectDeployment;
  runDeployFlow: typeof runDeployFlow;
}

export interface RegistrySessionItemResult {
  title: string;
  facts: readonly RegistrySetupFact[];
  output: readonly string[];
}

/** An item the user chose to skip after its installation could not complete. */
export interface RegistrySessionItemFailure {
  title: string;
  /** User-facing installation error, including any actionable follow-up lines. */
  message: string;
}

export type RegistrySessionOutcome =
  | ({ kind: "installed" } & RegistrySessionItemResult)
  | ({ kind: "failed" } & RegistrySessionItemFailure)
  | { kind: "cancelled"; title: string };

export interface RegistrySessionResult {
  items: readonly RegistrySessionItemResult[];
  /** Installation failures retained when a user skips an item. */
  failures: readonly RegistrySessionItemFailure[];
  /** Every item outcome in installation order. */
  outcomes?: readonly RegistrySessionOutcome[];
  /** Setup stopped outside an individual item after preserving settled results. */
  cancelled?: true;
  deployed?: "production";
}

export interface RegistrySession {
  add(title: string, output: readonly string[], setup?: RegistrySetupCompletion): void;
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
    const items = outcomes.flatMap((outcome) =>
      outcome.kind === "installed"
        ? [{ title: outcome.title, facts: outcome.facts, output: outcome.output }]
        : [],
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.kind === "failed" ? [{ title: outcome.title, message: outcome.message }] : [],
    );
    const session: RegistrySessionResult = { items, failures };
    if (outcomes.some((outcome) => outcome.kind !== "installed")) session.outcomes = outcomes;
    if (deployed !== undefined) session.deployed = deployed;
    return session;
  }

  return {
    add(title, itemOutput, setup = { facts: [] }) {
      outcomes.push({ kind: "installed", title, facts: setup.facts, output: itemOutput });
      deploymentRequired ||= setup.deploymentRequired === true;
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
