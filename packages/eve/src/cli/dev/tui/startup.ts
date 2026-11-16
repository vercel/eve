// The startup prompt paints before the rest of the terminal UI loads, so this
// module imports only what the startup draft needs.
import { LOGIN_CONNECTION_COMMAND_OPTIONS } from "#setup/flows/model-login-options.js";
import { createDevDiagnostics, type DevDiagnostics } from "../diagnostics.js";

import type { PromptArgumentSuggestion } from "./argument-typeahead.js";
import type { ArgumentTypeaheadCommand } from "./prompt-commands.js";
import { TerminalRenderer } from "./terminal-renderer.js";
import type { TuiDisplayOptions } from "./types.js";

export function inlineArgumentSuggestions(appRoot: string) {
  return async (
    command: ArgumentTypeaheadCommand,
  ): Promise<readonly PromptArgumentSuggestion[]> => {
    if (command === "loglevel") {
      return [
        { value: "none", label: "none", hint: "Hide logs" },
        { value: "error", label: "error", hint: "Errors only (default)" },
        { value: "warn", label: "warn", hint: "Warnings and errors" },
        {
          value: "debug",
          label: "debug",
          hint: "All severity-tagged logs",
        },
        { value: "all", label: "all", hint: "Include raw stdout and sandbox output" },
      ];
    }
    if (command === "login") {
      return LOGIN_CONNECTION_COMMAND_OPTIONS.map((option) => ({
        value: option.command,
        label: option.label,
      }));
    }
    if (command === "model") {
      const { gatewayModelCapabilities } = await import("#setup/boxes/model-capabilities.js");
      const { fetchGatewayCatalog, modelOptionsFromCatalog } =
        await import("#setup/boxes/select-model.js");
      const catalog = await fetchGatewayCatalog().catch(() => undefined);
      return modelOptionsFromCatalog(catalog).map((option) => {
        const capabilities = gatewayModelCapabilities(catalog, option.value);
        return {
          value: option.value,
          label: option.value,
          hint: option.hint,
          ...(capabilities?.reasoning
            ? {
                next: [
                  { value: "default", label: "default" },
                  ...capabilities.reasoningLevels.map((value) => ({ value, label: value })),
                ],
              }
            : {}),
        };
      });
    }
    const { browseRegistryCatalog } = await import("#cli/commands/registry.js");
    const catalog = await browseRegistryCatalog(appRoot);
    return catalog.items.map((item) => ({
      value: item.address,
      label: item.name,
      hint: item.description ?? item.address,
    }));
  };
}

export interface DevelopmentTuiStartup {
  readonly diagnostics: DevDiagnostics | undefined;
  readonly renderer: TerminalRenderer;
  finish(): { draft: string; queuedPrompt: string | undefined };
  shutdown(): Promise<void>;
}

export async function startDevelopmentTuiStartup(
  input: TuiDisplayOptions & {
    readonly appRoot: string;
    readonly initialInput?: string;
    readonly onExitRequest: () => void;
  },
): Promise<DevelopmentTuiStartup> {
  const diagnostics = await createDevDiagnostics(input.appRoot).catch(() => undefined);
  const renderer = new TerminalRenderer({
    ...input,
    diagnostics,
    argumentSuggestions: inlineArgumentSuggestions(input.appRoot),
    onExitRequest: input.onExitRequest,
  });
  renderer.beginStartupDraft({
    initialDraft: input.initialInput,
    title: input.name ?? "eve",
  });
  return {
    diagnostics,
    renderer,
    finish: () => renderer.finishStartupDraft(),
    async shutdown() {
      renderer.shutdown();
      await diagnostics?.close();
    },
  };
}
