import type { RegistrySetupRefusal } from "#setup/registry-setup-protocol.js";

export type HeadlessSetupEvent =
  | { version: 1; type: "progress"; level?: "warning"; message: string }
  | { version: 1; type: "external_action"; message: string; url: string; userCode?: string }
  | { version: 1; type: "completed"; item: string; completedItems: readonly string[] }
  | ({
      version: 1;
      type: "blocked";
      item: string;
      installed: boolean;
      completedItems: readonly string[];
      next: { command: string };
    } & RegistrySetupRefusal)
  | {
      version: 1;
      type: "failed";
      item: string;
      completedItems: readonly string[];
      message: string;
      next?: { command: string };
    }
  | {
      version: 1;
      type: "cancelled";
      item: string;
      completedItems: readonly string[];
      next?: { command: string };
    };

function shell(value: string): string {
  return /^[\w@./:-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function headlessSetupContinuation(input: { item: string; installed: boolean }): string {
  return [
    "eve",
    "add",
    shell(input.item),
    "--headless",
    ...(input.installed ? ["--skip-install"] : []),
  ].join(" ");
}

export function formatHeadlessSetupEvent(event: HeadlessSetupEvent): string {
  return JSON.stringify(event);
}
