import { createPrompter, type Prompter } from "#setup/prompter.js";

import { hasInteractiveTerminal } from "./preconditions.js";

export interface InitSelfModificationDependencies {
  createPrompter(): Prompter;
  hasInteractiveTerminal(): boolean;
}

const defaultDependencies: InitSelfModificationDependencies = {
  createPrompter,
  hasInteractiveTerminal,
};

/** Offers eve's self-modification subagent before the external coding-agent handoff. */
export async function selectInitSelfModification(
  dependencies: InitSelfModificationDependencies = defaultDependencies,
): Promise<boolean> {
  if (!dependencies.hasInteractiveTerminal()) return false;

  return dependencies.createPrompter().select({
    message: "Enable local self-modification?",
    description:
      "Self-modification adds a subagent that can edit your agent's source during local development.",
    options: [
      {
        value: true,
        label: "Enable self-modification",
        focusHint: "let your eve agent make source changes in dev",
      },
      {
        value: false,
        label: "Not now",
        focusHint: "continue with eve dev or an external coding agent",
      },
    ],
    initialValue: false,
  });
}
