import type { RegistryCatalogItem } from "#cli/commands/registry.js";
import type { Prompter, SelectOption } from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";
import { withSpinner } from "#setup/with-spinner.js";

import { createRegistrySession, type RegistrySessionResult } from "./registry-session.js";

type Item = RegistryCatalogItem;
export interface RegistryFlowDeps {
  browseRegistryCatalog: (typeof import("#cli/commands/registry.js"))["browseRegistryCatalog"];
  installRegistryItem: (typeof import("#cli/commands/registry.js"))["installRegistryItem"];
  detectDeployment: (typeof import("#setup/project-resolution.js"))["detectDeployment"];
  runDeployFlow: (typeof import("./deploy.js"))["runDeployFlow"];
}
const SECTIONS = {
  channels: {
    title: "Where should people reach your agent?",
    description: "You can add more later with /add.",
    featured: ["channel/web", "channel/slack", "channel/github", "channel/linear-agent"],
    includes: (item: Item) => item.name.startsWith("channel/"),
  },
  integrations: {
    title: "What should your agent be able to work with?",
    featured: [
      "extension/github-tools",
      "connection/linear",
      "connection/notion",
      "connection/vercel",
      "extension/agent-browser",
    ],
    includes: (item: Item) =>
      !item.name.startsWith("channel/") && !item.name.startsWith("experimental/"),
  },
} as const;

function label(item: Item): string {
  return item.title ?? item.name.split("/").at(-1) ?? item.name;
}

function orderedSectionItems(section: keyof typeof SECTIONS, catalog: readonly Item[]): Item[] {
  // Composite registry presets span multiple planner sections. The batch
  // planner presents their channel and capability components independently.
  const matching = catalog.filter(
    (item) => item.name.includes("/") && SECTIONS[section].includes(item),
  );
  const featured = SECTIONS[section].featured
    .map((name) => matching.find((item) => item.name === name))
    .filter((item): item is Item => item !== undefined);
  const featuredAddresses = new Set(featured.map((item) => item.address));
  return [...featured, ...matching.filter((item) => !featuredAddresses.has(item.address))];
}

function plannerLabel(item: Item): string {
  return item.name === "connection/linear" ? "Linear MCP" : label(item);
}

function sectionRows(
  section: keyof typeof SECTIONS,
  catalog: readonly Item[],
  selected: ReadonlySet<string>,
): SelectOption<string>[] {
  const featured = new Set<string>(SECTIONS[section].featured);
  return orderedSectionItems(section, catalog).map((item) => {
    const linearAgentSelected = selected.has("channel/linear-agent");
    const recommendation =
      item.name === "connection/linear" && linearAgentSelected
        ? "Recommended with Linear Agent"
        : undefined;
    return {
      value: item.address,
      label: plannerLabel(item),
      hint:
        recommendation === undefined
          ? item.description
          : item.description === undefined
            ? recommendation
            : `${recommendation} · ${item.description}`,
      ...(featured.has(item.name) ? { featured: true } : {}),
    };
  });
}

function selectedInSection(
  section: keyof typeof SECTIONS,
  catalog: readonly Item[],
  selected: ReadonlySet<string>,
): string[] {
  return catalog
    .filter((item) => SECTIONS[section].includes(item) && selected.has(item.address))
    .map((item) => item.address);
}

async function editSection(input: {
  section: keyof typeof SECTIONS;
  prompter: Prompter;
  catalog: readonly Item[];
  selected: Set<string>;
}): Promise<void> {
  const { section, catalog, prompter, selected } = input;
  const selectedAddresses = await prompter.select({
    message: SECTIONS[section].title,
    ...(section === "channels" ? { description: SECTIONS.channels.description } : {}),
    multiple: true,
    search: true,
    placeholder: section === "channels" ? "Search channels" : "Search integrations",
    plannerNavigation: true,
    plannerContinue: section === "channels" ? "integrations" : "review",
    initialValues: selectedInSection(section, catalog, selected),
    options: sectionRows(section, catalog, selected),
  });
  for (const item of catalog) {
    if (!SECTIONS[section].includes(item)) continue;
    selected.delete(item.address);
  }
  for (const address of selectedAddresses) selected.add(address);
}

async function editPlan(input: {
  prompter: Prompter;
  catalog: readonly Item[];
  selected: Set<string>;
}): Promise<"install" | "cancelled"> {
  let screen: "channels" | "integrations" | "review" = "channels";
  while (true) {
    if (screen !== "review") {
      try {
        await editSection({ ...input, section: screen });
      } catch (error) {
        if (!(error instanceof WizardCancelledError)) throw error;
        if (screen === "channels") return "cancelled";
        screen = "channels";
        continue;
      }
      screen = screen === "channels" ? "integrations" : "review";
      continue;
    }

    if (input.selected.size === 0) return "install";
    let review: "install" | "back";
    try {
      review = await input.prompter.select({
        message: "Review your agent",
        metadata: [...input.selected].map((address) => {
          const item = input.catalog.find((candidate) => candidate.address === address)!;
          return {
            label: item.name.startsWith("channel/") ? "Channel" : "Integration",
            value: label(item),
          };
        }),
        plannerBack: true,
        options: [
          { value: "install", label: "Install and set up" },
          { value: "back", label: "Back" },
        ],
      });
    } catch (error) {
      if (!(error instanceof WizardCancelledError)) throw error;
      screen = "integrations";
      continue;
    }
    if (review === "install") return "install";
    screen = "integrations";
  }
}

/** Collects a channel and integration plan, then installs every chosen item in order. */
export async function runRegistryFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  /** Registry item supplied by `/add <item>`, preselected before the planner opens. */
  initialAddress?: string;
  onItemStart?: (item: Item, index: number, total: number) => void;
  deps?: Partial<RegistryFlowDeps>;
}): Promise<{ kind: "done"; result: RegistrySessionResult } | { kind: "cancelled" }> {
  try {
    const browseRegistryCatalog =
      input.deps?.browseRegistryCatalog ??
      (await import("#cli/commands/registry.js")).browseRegistryCatalog;
    const catalog = await withSpinner(input.prompter, "Loading registry…", () =>
      browseRegistryCatalog(input.appRoot),
    );
    const selected = new Set<string>();
    if (input.initialAddress !== undefined) {
      const initialItem = catalog.items.find(
        (item) => item.address === input.initialAddress || item.name === input.initialAddress,
      );
      if (initialItem !== undefined) selected.add(initialItem.address);
    }
    if (
      (await editPlan({ prompter: input.prompter, catalog: catalog.items, selected })) !== "install"
    )
      return { kind: "cancelled" };
    const detectDeployment =
      input.deps?.detectDeployment ??
      (await import("#setup/project-resolution.js")).detectDeployment;
    const runDeployFlow = input.deps?.runDeployFlow ?? (await import("./deploy.js")).runDeployFlow;
    const session = createRegistrySession({ detectDeployment, runDeployFlow });
    const install =
      input.deps?.installRegistryItem ??
      (await import("#cli/commands/registry.js")).installRegistryItem;
    const items = [...selected].map((address) =>
      catalog.items.find((item) => item.address === address)!,
    );
    for (const [index, item] of items.entries()) {
      input.onItemStart?.(item, index, items.length);
      try {
        const installed = await (input.prompter.withExclusiveTerminal?.(() =>
          install(input.appRoot, item.address, {
            silent: true,
            prompter: input.prompter,
            signal: input.signal,
          }),
        ) ??
          install(input.appRoot, item.address, {
            silent: true,
            prompter: input.prompter,
            signal: input.signal,
          }));
        session.add(item.address, label(item), installed.output, installed.setup);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const detail = message.split("\n").find((line) => line.trim() !== "");
        const fullDetail = error instanceof Error ? (error.stack ?? message) : message;
        const action = await input.prompter.select({
          message: `Couldn't add ${label(item)}`,
          ...(detail === undefined ? {} : { description: detail }),
          options: [
            { value: "skip", label: `Skip ${label(item)}` },
            { value: "cancel", label: "Cancel setup" },
          ],
        });
        session.addFailure(item.address, label(item), detail ?? "Installation failed.", fullDetail);
        if (action === "cancel") return { kind: "done", result: session.result() };
      }
    }
    const result = await session.continueAfterInstall({
      appRoot: input.appRoot,
      prompter: input.prompter,
      signal: input.signal,
    });
    return { kind: "done", result };
  } catch (error) {
    if (error instanceof WizardCancelledError) return { kind: "cancelled" };
    throw error;
  }
}
