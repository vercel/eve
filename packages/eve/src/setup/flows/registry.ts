import type { RegistryCatalogItem } from "#cli/commands/registry.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import type { Prompter, SingleSelectOptions } from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";
import { withSpinner } from "#setup/with-spinner.js";

import { createRegistrySession, type RegistrySessionResult } from "./registry-session.js";

type Item = RegistryCatalogItem;
function label(item: Item): string {
  return item.name;
}

export interface RegistryPlannerContext {
  /** Steps owned by an enclosing journey, rendered before the registry steps. */
  prefixSteps?: readonly { label: string; complete?: boolean }[];
  /** Facts owned by the enclosing journey, rendered before registry selections. */
  reviewMetadata?: readonly { label: string; value: string }[];
  reviewMessage?: string;
  primaryActionLabel?: string;
  emptyActionLabel?: string;
}

export interface RegistryFlowDeps {
  browseRegistryCatalog: (typeof import("#cli/commands/registry.js"))["browseRegistryCatalog"];
  installRegistryItem: (typeof import("#cli/commands/registry.js"))["installRegistryItem"];
  detectDeployment: (typeof import("#setup/project-resolution.js"))["detectDeployment"];
  runDeployFlow: (typeof import("./deploy.js"))["runDeployFlow"];
}

export class RegistryFlowFailedError extends Error {
  readonly completed: RegistrySessionResult;

  constructor(error: unknown, completed: RegistrySessionResult) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "RegistryFlowFailedError";
    this.completed = completed;
  }
}

function hasSettledOutcomes(
  result: RegistrySessionResult | undefined,
): result is RegistrySessionResult {
  return (
    result !== undefined &&
    (result.items.length > 0 || result.failures.length > 0 || result.outcomes !== undefined)
  );
}

/** Searches the catalog and installs one selected item with its required setup. */
export async function runRegistryFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  /** Registry item supplied by `/add <item>`, installed directly. */
  initialAddress?: string;
  plannerContext?: RegistryPlannerContext;
  onScreen?: (input: {
    screen: "registry_channels" | "registry_integrations" | "registry_review" | "registry_install";
    registrySelectedCount?: number;
  }) => void;
  onItemStart?: (item: Item, index: number, total: number) => void;
  /** Gives each installation its own cancellation boundary without ending the batch. */
  runItem?<T>(task: (signal?: AbortSignal) => Promise<T>): Promise<T>;
  deps?: Partial<RegistryFlowDeps>;
}): Promise<{ kind: "done"; result: RegistrySessionResult } | { kind: "cancelled" }> {
  let session: ReturnType<typeof createRegistrySession> | undefined;
  try {
    const initialAddress = input.initialAddress?.trim();
    let items: Item[];
    if (initialAddress !== undefined && initialAddress !== "") {
      items = [{ address: initialAddress, name: initialAddress, source: "Registry" }];
    } else {
      const browseRegistryCatalog =
        input.deps?.browseRegistryCatalog ??
        (await import("#cli/commands/registry.js")).browseRegistryCatalog;
      const catalogResult = await withSpinner(input.prompter, "Loading registry…", () =>
        browseRegistryCatalog(input.appRoot),
      );
      const catalog = [...catalogResult.items];
      const address = await input.prompter.select({
        message: "Add to your agent",
        search: true,
        options: catalog.map((item) => ({
          value: item.address,
          label: item.name,
          hint: item.address,
        })),
        notices: catalogResult.errors.map((error) => ({
          tone: "warning" as const,
          text: `${error.registry}: ${error.message}`,
        })),
      });
      const item = catalog.find((item) => item.address === address);
      if (item === undefined)
        throw new Error("That registry item is no longer available. Run /add to try again.");
      items = [item];
    }

    const installRegistryItem =
      input.deps?.installRegistryItem ??
      (await import("#cli/commands/registry.js")).installRegistryItem;
    const detectDeployment =
      input.deps?.detectDeployment ??
      (await import("#setup/project-resolution.js")).detectDeployment;
    const runDeployFlow = input.deps?.runDeployFlow ?? (await import("./deploy.js")).runDeployFlow;
    session = createRegistrySession({ detectDeployment, runDeployFlow });
    input.onScreen?.({ screen: "registry_install" });
    const activeSession = session;
    for (const [index, item] of items.entries()) {
      input.signal?.throwIfAborted();
      input.onItemStart?.(item, index, items.length);
      try {
        const install = (signal = input.signal) =>
          installRegistryItem(input.appRoot, item.address, {
            silent: true,
            prompter: input.prompter,
            signal,
          });
        const run = () => (input.runItem === undefined ? install() : input.runItem(install));
        const installed = await (input.prompter.withExclusiveTerminal?.(run) ?? run());
        activeSession.add(label(item), installed.output, installed.setup);
      } catch (error) {
        input.signal?.throwIfAborted();
        if (error instanceof WizardCancelledError) {
          activeSession.addCancellation(label(item));
          continue;
        }
        if (error instanceof HumanActionRequiredError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const failureMessage = message.trim() || "Installation failed.";
        const summary = failureMessage.split("\n").find((line) => line.trim() !== "");
        activeSession.addFailure(label(item), failureMessage);
        const request: SingleSelectOptions<"skip" | "cancel"> = {
          message: `Couldn't add ${label(item)}`,
          options: [
            { value: "skip", label: `Skip ${label(item)}` },
            { value: "cancel", label: "Cancel setup" },
          ],
        };
        if (summary !== undefined) request.description = summary;
        const action = await input.prompter.select(request);
        if (action === "cancel") {
          return { kind: "done", result: { ...activeSession.result(), cancelled: true } };
        }
      }
    }
    return {
      kind: "done",
      result: await activeSession.continueAfterInstall({
        appRoot: input.appRoot,
        prompter: input.prompter,
        signal: input.signal,
      }),
    };
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      const settled = session?.result();
      return hasSettledOutcomes(settled)
        ? { kind: "done", result: { ...settled, cancelled: true } }
        : { kind: "cancelled" };
    }
    const settled = session?.result();
    if (hasSettledOutcomes(settled)) {
      throw new RegistryFlowFailedError(error, settled);
    }
    throw error;
  }
}
