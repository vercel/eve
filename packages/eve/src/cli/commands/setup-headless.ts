import type {
  RegistrySetupBlocker,
  RegistrySetupCompletion,
} from "#setup/registry-setup-protocol.js";

export interface HeadlessSetupCommand {
  command: string;
  args: readonly string[];
}

export type HeadlessSetupEvent =
  | { version: 1; type: "progress"; level?: "warning"; message: string }
  | {
      version: 1;
      type: "external_action";
      id: string;
      blocking: true;
      message: string;
      url: string;
      userCode?: string;
    }
  | { version: 1; type: "external_action_resolved"; id: string }
  | {
      version: 1;
      type: "completed";
      item: string;
      completedItems: readonly string[];
      deploymentRequired?: true;
      next?: HeadlessSetupCommand;
    }
  | ({
      version: 1;
      type: "blocked";
      item: string;
      installed: boolean;
      completedItems: readonly string[];
      next: HeadlessSetupCommand;
    } & RegistrySetupBlocker)
  | {
      version: 1;
      type: "failed";
      item: string;
      completedItems: readonly string[];
      message: string;
      failureCode?: "pnpm_build_policy" | "dependency_install";
      /** True when every project file tracked by the installer was restored. */
      rolledBack?: boolean;
      /** Project-relative paths that could not be restored. Never contains file contents. */
      changed?: readonly string[];
      next?: HeadlessSetupCommand;
    }
  | {
      version: 1;
      type: "cancelled";
      item: string;
      completedItems: readonly string[];
      next?: HeadlessSetupCommand;
    };

export function headlessSetupContinuation(input: {
  item: string;
  installed: boolean;
  question?: Extract<RegistrySetupBlocker, { status: "input_required" }>["question"];
}): HeadlessSetupCommand {
  const answer =
    input.question?.kind === "environment"
      ? []
      : input.question === undefined
        ? []
        : ["--answer", `${input.question.key}=<JSON value>`];
  return {
    command: "eve",
    args: [
      "add",
      input.item,
      "--non-interactive",
      ...(input.installed ? ["--skip-install"] : []),
      ...answer,
    ],
  };
}

export type HeadlessIntegrationSetupEvent =
  | {
      version: 1;
      type: "external_action";
      id: string;
      blocking: true;
      message: string;
      url: string;
      userCode?: string;
    }
  | { version: 1; type: "external_action_resolved"; id: string }
  | { version: 1; type: "completed"; item: string }
  | { version: 1; type: "cancelled"; item: string }
  | ({ version: 1; type: "blocked" } & RegistrySetupBlocker);

export function reportHeadlessSetupCompletion(input: {
  logger: { log(message: string): void };
  item: string;
  completion: RegistrySetupCompletion | false;
  nonInteractive: boolean | undefined;
}): RegistrySetupCompletion | undefined {
  if (input.completion === false) return undefined;
  if (input.nonInteractive === true) {
    input.logger.log(
      serializeHeadlessSetupEvent({
        version: 1,
        type: "completed",
        item: input.item,
        completedItems: [input.item],
        ...(input.completion.deploymentRequired === true
          ? { deploymentRequired: true as const, next: { command: "eve", args: ["deploy"] } }
          : {}),
      }),
    );
  }
  return input.completion;
}

export function serializeHeadlessSetupEvent(
  event: HeadlessSetupEvent | HeadlessIntegrationSetupEvent,
): string {
  return JSON.stringify(event);
}
