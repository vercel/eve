import type { RegistryCatalogItem } from "#cli/commands/registry.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import { PlannerNavigationError } from "#setup/prompter.js";
import type {
  MultiSelectOptions,
  Prompter,
  SelectNotice,
  SelectOption,
  SingleSelectOptions,
} from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";
import { withSpinner } from "#setup/with-spinner.js";

import { createRegistrySession, type RegistrySessionResult } from "./registry-session.js";

type Item = RegistryCatalogItem;
export type RegistryPlannerSection = keyof typeof SECTIONS;
type Section = RegistryPlannerSection;
type PlannerScreen = Section | "review";

const PLANNER_STEPS = ["Channels", "Integrations", "Review"] as const;

export interface RegistryPlannerContext {
  /** Steps owned by an enclosing journey, rendered before the registry steps. */
  prefixSteps?: readonly { label: string; complete?: boolean }[];
  /** Facts owned by the enclosing journey, rendered before registry selections. */
  reviewMetadata?: readonly { label: string; value: string }[];
  reviewMessage?: string;
  primaryActionLabel?: string;
  emptyActionLabel?: string;
  /** Let Left Arrow on Channels return control to the enclosing journey. */
  navigateBackBeforeChannels?: boolean;
}

export type RegistryHumanActionRecovery = (
  error: HumanActionRequiredError,
) => Promise<"retry" | "cancel">;

export interface RegistryFlowDeps {
  browseRegistryCatalog: (typeof import("#cli/commands/registry.js"))["browseRegistryCatalog"];
  getRegistryItemManifest: (typeof import("#cli/commands/registry.js"))["getRegistryItemManifest"];
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

const SECTIONS = {
  channels: {
    title: "Where should people reach your agent?",
    description: "You can add more later with /add.",
    featured: [
      "channel/web",
      "channel/slack",
      "channel/github",
      "channel/linear-agent",
      "channel/photon-imessage",
    ],
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

function isPlannerItem(section: Section, item: Item): boolean {
  return item.name.includes("/") && SECTIONS[section].includes(item);
}

function orderedSectionItems(section: Section, catalog: readonly Item[]): Item[] {
  // Product-level presets are installed as one item when explicitly requested;
  // the bare planner presents their independently installable components.
  const matching = catalog.filter((item) => isPlannerItem(section, item));
  const featured = SECTIONS[section].featured
    .map((name) => matching.find((item) => item.name === name))
    .filter((item): item is Item => item !== undefined);
  const featuredAddresses = new Set(featured.map((item) => item.address));
  return [...featured, ...matching.filter((item) => !featuredAddresses.has(item.address))];
}

function plannerLabel(item: Item): string {
  return item.name === "connection/linear" ? "Linear MCP" : label(item);
}

function sectionRows(section: Section, catalog: readonly Item[]): SelectOption<string>[] {
  return orderedSectionItems(section, catalog).map((item) => ({
    value: item.address,
    label: plannerLabel(item),
    hint: item.description,
  }));
}

function selectedInSection(
  section: Section,
  catalog: readonly Item[],
  selected: ReadonlySet<string>,
): string[] {
  return catalog
    .filter((item) => isPlannerItem(section, item) && selected.has(item.address))
    .map((item) => item.address);
}

function plannerNavigation(
  activeStep: number,
  input: {
    catalog: readonly Item[];
    selected: ReadonlySet<string>;
    plannerContext?: RegistryPlannerContext;
  },
): NonNullable<MultiSelectOptions<string>["navigation"]> {
  const prefix = (input.plannerContext?.prefixSteps ?? []).map((step) => ({
    label: step.label,
    complete: step.complete,
  }));
  return {
    kind: "planner",
    activeStep: prefix.length + activeStep,
    steps: [
      ...prefix,
      ...PLANNER_STEPS.map((label, index) => {
        if (index === 2) return { label };
        const section = index === 0 ? "channels" : "integrations";
        const count = selectedInSection(section, input.catalog, input.selected).length;
        return count === 0 ? { label } : { label, count };
      }),
    ],
  };
}

function replaceSectionSelection(input: {
  section: Section;
  catalog: readonly Item[];
  selected: Set<string>;
  addresses: readonly string[];
}): void {
  for (const item of input.catalog) {
    if (isPlannerItem(input.section, item)) input.selected.delete(item.address);
  }
  for (const address of input.addresses) input.selected.add(address);
}

async function editSection(input: {
  section: Section;
  prompter: Prompter;
  catalog: readonly Item[];
  selected: Set<string>;
  notices?: readonly SelectNotice[];
}): Promise<"back" | "forward"> {
  const { section, catalog, prompter, selected } = input;
  const request: MultiSelectOptions<string> = {
    message: SECTIONS[section].title,
    multiple: true,
    search: true,
    placeholder: section === "channels" ? "Search channels" : "Search integrations",
    navigation: plannerNavigation(section === "channels" ? 0 : 1, input),
    initialValues: selectedInSection(section, catalog, selected),
    options: sectionRows(section, catalog),
  };
  if (section === "channels") request.description = SECTIONS.channels.description;
  if (input.notices !== undefined) request.notices = input.notices;
  try {
    const addresses = await prompter.select(request);
    replaceSectionSelection({ section, catalog, selected, addresses });
    return "forward";
  } catch (error) {
    if (!(error instanceof PlannerNavigationError)) throw error;
    const addresses = error.values.map((value) => {
      if (typeof value !== "string")
        throw new Error("Registry planner returned a non-string item.");
      return value;
    });
    replaceSectionSelection({ section, catalog, selected, addresses });
    return error.direction;
  }
}

async function editPlan(input: {
  prompter: Prompter;
  catalog: readonly Item[];
  itemsByAddress: ReadonlyMap<string, Item>;
  selected: Set<string>;
  notices?: readonly SelectNotice[];
  initialScreen: PlannerScreen;
  plannerContext?: RegistryPlannerContext;
}): Promise<"install" | "cancelled" | "back-before-channels"> {
  let screen = input.initialScreen;
  let notices = input.notices;
  while (true) {
    if (screen !== "review") {
      try {
        const direction = await editSection({
          ...input,
          section: screen,
          notices,
        });
        notices = undefined;
        if (direction === "back") {
          if (screen === "integrations") screen = "channels";
          else if (input.plannerContext?.navigateBackBeforeChannels === true) {
            return "back-before-channels";
          }
        } else {
          screen = screen === "channels" ? "integrations" : "review";
        }
      } catch (error) {
        if (!(error instanceof WizardCancelledError)) throw error;
        return "cancelled";
      }
      continue;
    }

    try {
      const hasSelections = input.selected.size > 0;
      const selectedItems = [...input.selected].map((address) => {
        const item = input.itemsByAddress.get(address);
        if (item === undefined)
          throw new Error(`Registry item "${address}" is no longer available.`);
        return item;
      });
      const channels = selectedItems.filter((item) => item.name.startsWith("channel/"));
      const integrations = selectedItems.filter((item) => !item.name.startsWith("channel/"));
      const selectionMetadata = [
        ...(channels.length === 0
          ? []
          : [{ label: "Channels", value: channels.map(label).join(", ") }]),
        ...(integrations.length === 0
          ? []
          : [{ label: "Integrations", value: integrations.map(label).join(", ") }]),
      ];
      const request: SingleSelectOptions<"install" | "back"> = {
        message: input.plannerContext?.reviewMessage ?? "Review additions",
        metadata: [...(input.plannerContext?.reviewMetadata ?? []), ...selectionMetadata],
        navigation: plannerNavigation(2, input),
        options: [
          {
            value: "install",
            label: hasSelections
              ? (input.plannerContext?.primaryActionLabel ?? "Install and set up")
              : (input.plannerContext?.emptyActionLabel ?? "Finish without adding"),
          },
          { value: "back", label: "Back" },
        ],
      };
      if (!hasSelections) request.description = "No channels or integrations selected.";
      if (notices !== undefined) request.notices = notices;
      const review = await input.prompter.select(request);
      notices = undefined;
      if (review === "install") return "install";
    } catch (error) {
      if (error instanceof PlannerNavigationError && error.direction === "back") {
        screen = "integrations";
        continue;
      }
      if (!(error instanceof WizardCancelledError)) throw error;
      return "cancelled";
    }
    screen = "integrations";
  }
}

function itemSource(address: string): string {
  if (address.startsWith("@")) return address.split("/")[0] ?? address;
  if (/^https?:\/\//u.test(address)) {
    try {
      return new URL(address).host;
    } catch {
      return address;
    }
  }
  return "Vercel";
}

function manifestRecord(manifest: unknown): Record<string, unknown> {
  return typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
    ? (manifest as Record<string, unknown>)
    : {};
}

function manifestComponents(manifest: Record<string, unknown>): string[] {
  const meta = manifest.meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return [];
  const eve = (meta as Record<string, unknown>).eve;
  if (typeof eve !== "object" || eve === null || Array.isArray(eve)) return [];
  const components = (eve as Record<string, unknown>).components;
  if (!Array.isArray(components)) return [];
  return components.flatMap((component) => {
    if (typeof component !== "object" || component === null || Array.isArray(component)) return [];
    const item = (component as Record<string, unknown>).item;
    return typeof item === "string" ? [item] : [];
  });
}

async function resolveInitialItems(input: {
  appRoot: string;
  address: string;
  catalog: readonly Item[];
  prompter: Prompter;
  getRegistryItemManifest: RegistryFlowDeps["getRegistryItemManifest"];
}): Promise<Item[]> {
  const known = input.catalog.find(
    (item) => item.address === input.address || item.name === input.address,
  );
  if (known !== undefined && known.name.includes("/")) return [known];

  const manifest = manifestRecord(
    await withSpinner(input.prompter, "Loading registry item…", () =>
      input.getRegistryItemManifest(input.appRoot, input.address),
    ),
  );
  const components = manifestComponents(manifest);
  if (components.length > 0) {
    return components.map((address) => {
      const component = input.catalog.find(
        (item) => item.address === address || item.name === address,
      );
      if (component === undefined) {
        throw new Error(
          `Registry package "${input.address}" references unavailable item "${address}".`,
        );
      }
      return component;
    });
  }
  if (known !== undefined) return [known];

  const item: Item = {
    address: input.address,
    name: typeof manifest.name === "string" ? manifest.name : input.address,
    source: itemSource(input.address),
  };
  if (typeof manifest.title === "string") item.title = manifest.title;
  if (typeof manifest.type === "string") item.type = manifest.type;
  if (typeof manifest.description === "string") item.description = manifest.description;
  return [item];
}

async function recoverHumanAction<T>(
  task: () => Promise<T>,
  recover: RegistryHumanActionRecovery | undefined,
): Promise<T | undefined> {
  while (true) {
    try {
      return await task();
    } catch (error) {
      if (!(error instanceof HumanActionRequiredError) || recover === undefined) throw error;
      if ((await recover(error)) === "cancel") return undefined;
    }
  }
}

/** Collects a channel and integration plan, then installs every chosen item in order. */
export async function runRegistryFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  /** Registry item supplied by `/add <item>`, preselected before the planner opens. */
  initialAddress?: string;
  /** First screen for an unaddressed flow; onboarding defaults to channels. */
  initialScreen?: RegistryPlannerSection;
  initialAddresses?: readonly string[];
  plannerContext?: RegistryPlannerContext;
  recoverHumanAction?: RegistryHumanActionRecovery;
  onItemStart?: (item: Item, index: number, total: number) => void;
  deps?: Partial<RegistryFlowDeps>;
}): Promise<
  | { kind: "done"; result: RegistrySessionResult }
  | { kind: "cancelled" }
  | { kind: "navigate-back"; selectedAddresses: readonly string[] }
> {
  let session: ReturnType<typeof createRegistrySession> | undefined;
  try {
    const registry =
      input.deps?.browseRegistryCatalog === undefined ||
      input.deps?.getRegistryItemManifest === undefined ||
      input.deps?.installRegistryItem === undefined
        ? await import("#cli/commands/registry.js")
        : undefined;
    const browseRegistryCatalog =
      input.deps?.browseRegistryCatalog ?? registry!.browseRegistryCatalog;
    const getRegistryItemManifest =
      input.deps?.getRegistryItemManifest ?? registry!.getRegistryItemManifest;
    const installRegistryItem = input.deps?.installRegistryItem ?? registry!.installRegistryItem;
    const catalogResult = await withSpinner(input.prompter, "Loading registry…", () =>
      browseRegistryCatalog(input.appRoot),
    );
    const catalog = [...catalogResult.items];
    const selected = new Set<string>(input.initialAddresses);
    const initialAddress = input.initialAddress?.trim();
    if (initialAddress !== undefined && initialAddress !== "") {
      const items = await resolveInitialItems({
        appRoot: input.appRoot,
        address: initialAddress,
        catalog,
        prompter: input.prompter,
        getRegistryItemManifest,
      });
      for (const item of items) {
        if (!catalog.some((candidate) => candidate.address === item.address)) catalog.push(item);
        selected.add(item.address);
      }
    }
    const notices = catalogResult.errors.map((error) => ({
      tone: "warning" as const,
      text: `${error.registry}: ${error.message}`,
    }));
    const itemsByAddress = new Map(catalog.map((item) => [item.address, item]));
    const plan = await editPlan({
      prompter: input.prompter,
      catalog,
      itemsByAddress,
      selected,
      notices,
      initialScreen:
        initialAddress !== undefined && initialAddress !== ""
          ? "review"
          : (input.initialScreen ?? "channels"),
      plannerContext: input.plannerContext,
    });
    if (plan === "back-before-channels") {
      return { kind: "navigate-back", selectedAddresses: [...selected] };
    }
    if (plan !== "install") return { kind: "cancelled" };

    const detectDeployment =
      input.deps?.detectDeployment ??
      (await import("#setup/project-resolution.js")).detectDeployment;
    const runDeployFlow = input.deps?.runDeployFlow ?? (await import("./deploy.js")).runDeployFlow;
    session = createRegistrySession({ detectDeployment, runDeployFlow });
    const activeSession = session;
    const items = [...selected].map((address) => {
      const item = itemsByAddress.get(address);
      if (item === undefined) throw new Error(`Registry item "${address}" is no longer available.`);
      return item;
    });
    for (const [index, item] of items.entries()) {
      input.signal?.throwIfAborted();
      input.onItemStart?.(item, index, items.length);
      try {
        const install = () =>
          installRegistryItem(input.appRoot, item.address, {
            silent: true,
            prompter: input.prompter,
            signal: input.signal,
          });
        const installed = await recoverHumanAction(
          () => input.prompter.withExclusiveTerminal?.(install) ?? install(),
          input.recoverHumanAction,
        );
        if (installed === undefined) throw new WizardCancelledError();
        activeSession.add(label(item), installed.output, installed.setup);
      } catch (error) {
        input.signal?.throwIfAborted();
        if (error instanceof WizardCancelledError || error instanceof HumanActionRequiredError) {
          throw error;
        }
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
    const result = await recoverHumanAction(
      () =>
        activeSession.continueAfterInstall({
          appRoot: input.appRoot,
          prompter: input.prompter,
          signal: input.signal,
        }),
      input.recoverHumanAction,
    );
    return {
      kind: "done",
      result: result ?? { ...activeSession.result(), cancelled: true },
    };
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      const settled = session?.result();
      return settled !== undefined && (settled.items.length > 0 || settled.failures.length > 0)
        ? { kind: "done", result: { ...settled, cancelled: true } }
        : { kind: "cancelled" };
    }
    const settled = session?.result();
    if (settled !== undefined && (settled.items.length > 0 || settled.failures.length > 0)) {
      throw new RegistryFlowFailedError(error, settled);
    }
    throw error;
  }
}
