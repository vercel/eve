import {
  addRegistryItems,
  getRegistryItems,
  type RegistryConfig,
} from "#compiled/shadcn-registry/index.js";
import { z } from "#compiled/zod/index.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { mergeRegistrySetupCompletions } from "#setup/registry-setup-completion.js";
import type { RegistrySetupCompletion } from "#setup/registry-setup-protocol.js";

import { hasInteractiveTerminal } from "./preconditions.js";
import type { AddCommandOptions, RegistryCommandLogger } from "./registry.js";
import type { RegistrySetupCommand } from "./registry-setup-command.js";

export const RegistryPackageComponentSchema = z.object({
  item: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  default: z.boolean().default(false),
});

export type RegistryPackageComponent = z.infer<typeof RegistryPackageComponentSchema>;

interface PackageMetadata {
  requires?: string;
  setup?: RegistrySetupCommand[];
}

export interface RegistryPackageDependencies {
  createPrompter?: () => Prompter;
  hasInteractiveTerminal?: () => boolean;
}

export interface RegistryPackageOperations {
  itemAddress(item: string): string;
  metadata(item: unknown): PackageMetadata | undefined;
  assertCompatibleVersion(requiredVersion: string | undefined): void;
  runSetups(input: {
    item: string;
    setups: RegistrySetupCommand[];
    prompter: Prompter;
  }): Promise<RegistrySetupCompletion | false>;
  setupReminder(item: string): string;
}

async function selectComponents(
  item: string,
  components: readonly RegistryPackageComponent[],
  options: AddCommandOptions & { prompter?: Prompter },
  interactive: boolean,
  getPrompter: () => Prompter,
): Promise<readonly RegistryPackageComponent[]> {
  if (options.prompter === undefined && (options.yes === true || !interactive)) {
    return components.filter((component) => component.default);
  }
  const prompter = getPrompter();
  const selected = await prompter.select<string>({
    message: `Add ${item}`,
    description: "Select what you want to add to your agent.",
    multiple: true,
    required: true,
    initialValues: components
      .filter((component) => component.default)
      .map((component) => component.item),
    options: components.map((component) => ({
      value: component.item,
      label: component.label,
      hint: component.description,
    })),
  });
  const selectedItems = new Set(selected);
  return components.filter((component) => selectedItems.has(component.item));
}

/** Resolves, installs, and configures the selected components of a registry package. */
export async function runRegistryPackage(input: {
  logger: RegistryCommandLogger;
  appRoot: string;
  item: string;
  components: readonly RegistryPackageComponent[];
  config: RegistryConfig;
  options: AddCommandOptions & { prompter?: Prompter; signal?: AbortSignal };
  dependencies: RegistryPackageDependencies;
  operations: RegistryPackageOperations;
}): Promise<RegistrySetupCompletion | false> {
  const { logger, appRoot, item, components, config, options, dependencies, operations } = input;
  const interactive = dependencies.hasInteractiveTerminal?.() ?? hasInteractiveTerminal();
  let prompter = options.prompter;
  const getPrompter = (): Prompter =>
    (prompter ??= dependencies.createPrompter?.() ?? createPrompter());

  const selected = await selectComponents(item, components, options, interactive, getPrompter);
  const addresses = selected.map((component) => operations.itemAddress(component.item));
  const manifests = await getRegistryItems(addresses, { config });
  if (manifests.length !== selected.length) {
    throw new Error(`Registry package "${item}" could not resolve all selected components.`);
  }
  const entries = manifests.map((manifest) => {
    const metadata = operations.metadata(manifest);
    operations.assertCompatibleVersion(metadata?.requires);
    return metadata;
  });

  if (options.skipInstall !== true) {
    await addRegistryItems(addresses, {
      config,
      cwd: appRoot,
      overwrite: options.overwrite,
      silent: options.silent,
    });
  }
  let completion: RegistrySetupCompletion = { facts: [] };
  if (options.skipSetup === true) return completion;

  if (options.yes !== true && options.prompter === undefined && !interactive) {
    logger.log(operations.setupReminder(item));
    return completion;
  }

  for (const metadata of entries) {
    if (metadata?.setup === undefined) continue;
    const result = await operations.runSetups({
      item,
      setups: metadata.setup,
      prompter: getPrompter(),
    });
    if (result === false) return false;
    completion = mergeRegistrySetupCompletions(completion, result);
  }
  return completion;
}
