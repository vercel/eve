import { createPrompter, type Prompter } from "#setup/prompter.js";
import { parseProjectName, validateProjectName } from "#setup/project-name.js";

import { hasInteractiveTerminal } from "./preconditions.js";

export interface InitConfirmDependencies {
  createPrompter(): Prompter;
  hasInteractiveTerminal(): boolean;
}

const defaultDependencies: InitConfirmDependencies = {
  createPrompter,
  hasInteractiveTerminal,
};

export type InitNonEmptyDirectoryTarget =
  | { kind: "current-directory" }
  | { kind: "subdirectory"; name: string };

function formatEntries(entries: readonly string[]): string {
  const visible = entries.slice(0, 5).join(", ");
  const suffix = entries.length > 5 ? `, and ${entries.length - 5} more` : "";
  return `${visible}${suffix}`;
}

export async function confirmExistingPackageIntegration(
  summary: readonly string[],
  dependencies: InitConfirmDependencies = defaultDependencies,
): Promise<void> {
  if (!dependencies.hasInteractiveTerminal()) {
    throw new Error(
      `Existing-package integration requires confirmation. Planned edits:\n${summary.map((line) => `  - ${line}`).join("\n")}\n\nRe-run with --yes to apply these edits. Package-manager changes will remain if installation fails.`,
    );
  }
  const prompter = dependencies.createPrompter();
  const confirmed = await prompter.select<boolean>({
    message: "Apply these edits?",
    details: ["Planned edits", ...summary.map((line) => `• ${line}`)],
    options: [
      { value: true, label: "Apply edits and install dependencies" },
      { value: false, label: "Cancel", accent: "warning" },
    ],
    initialValue: true,
  });
  if (!confirmed) throw new Error("Existing-project integration cancelled; no files were changed.");
}

export async function confirmInitInNonEmptyDirectory(
  entries: readonly string[],
  dependencies: InitConfirmDependencies = defaultDependencies,
): Promise<InitNonEmptyDirectoryTarget> {
  const found = formatEntries(entries);
  if (!dependencies.hasInteractiveTerminal()) {
    throw new Error(
      `Cannot choose where to initialize the non-empty current directory without an interactive terminal. Found: ${found}. Pass a new directory name, for example: eve init my-agent.`,
    );
  }

  const prompter = dependencies.createPrompter();
  const choice = await prompter.select<"current-directory" | "subdirectory">({
    message: "Where should eve initialize the project?",
    description: `The current directory isn't empty. Found: ${found}.`,
    options: [
      {
        value: "subdirectory",
        label: "Create a new subdirectory",
        hint: "Keep the current directory unchanged",
      },
      {
        value: "current-directory",
        label: "Use the current directory",
        hint: "Overwrite files at generated paths",
        accent: "warning",
      },
    ],
    initialValue: "subdirectory",
  });
  if (choice === "current-directory") return { kind: "current-directory" };

  const name = await prompter.text({
    message: "Subdirectory name",
    defaultValue: "my-agent",
    validate: validateProjectName,
  });
  return { kind: "subdirectory", name: parseProjectName(name) };
}
