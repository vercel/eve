import type { RegistrySetupBlocker } from "#setup/registry-setup-protocol.js";

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
  | { version: 1; type: "completed"; item: string; completedItems: readonly string[] }
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
}): HeadlessSetupCommand {
  return {
    command: "eve",
    args: ["add", input.item, "--non-interactive", ...(input.installed ? ["--skip-install"] : [])],
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

export function serializeHeadlessSetupEvent(
  event: HeadlessSetupEvent | HeadlessIntegrationSetupEvent,
): string {
  return JSON.stringify(event);
}
