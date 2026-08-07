import type { Asker } from "#setup/ask.js";
import type { Prompter } from "#setup/prompter.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import type { RegistrySetupCompletion } from "#setup/registry-setup-protocol.js";
import { WizardCancelledError } from "#setup/step.js";

import type { IntegrationSetupEnvironment } from "./shared/environment.js";

export type SetupPresenter = Pick<Prompter, "log" | "note"> & {
  nextSteps(lines: readonly string[]): void;
  externalAction(input: { url: string; userCode?: string; message: string }): void;
};

export interface SetupPrepareContext {
  readonly appRoot: string;
  readonly asker: Asker;
  readonly environment: IntegrationSetupEnvironment;
  readonly presenter: SetupPresenter;
  readonly resolveVercelProject: (integration: string) => Promise<VercelProjectReference>;
  signal?: AbortSignal;
  force?: boolean;
}

export interface SetupApplyContext {
  readonly appRoot: string;
  readonly presenter: SetupPresenter;
  signal?: AbortSignal;
  force?: boolean;
}

export type IntegrationSetupResult =
  | { readonly kind: "done"; readonly completion: RegistrySetupCompletion }
  | { readonly kind: "cancelled" };

interface SetupIntegrationDefinition<Plan> {
  readonly kind: string;
  readonly label: string;
  readonly hint?: string;
  prepare(context: SetupPrepareContext): Promise<Plan>;
  apply(plan: Plan, context: SetupApplyContext): Promise<RegistrySetupCompletion>;
}

export interface SetupIntegration {
  readonly kind: string;
  readonly label: string;
  hint?: string;
  run(input: {
    prepare: SetupPrepareContext;
    apply: SetupApplyContext;
  }): Promise<IntegrationSetupResult>;
}

/** Captures an integration's private plan type behind one executable lifecycle. */
export function defineSetupIntegration<Plan>(
  definition: SetupIntegrationDefinition<Plan>,
): SetupIntegration {
  const registered: SetupIntegration = {
    kind: definition.kind,
    label: definition.label,
    async run(contexts) {
      try {
        const plan = await definition.prepare(contexts.prepare);
        return { kind: "done", completion: await definition.apply(plan, contexts.apply) };
      } catch (error) {
        if (error instanceof WizardCancelledError) return { kind: "cancelled" };
        throw error;
      }
    },
  };
  if (definition.hint !== undefined) registered.hint = definition.hint;
  return registered;
}
