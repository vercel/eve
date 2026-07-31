import type { RegistryCatalogItem } from "#cli/commands/registry.js";
import type {
  Prompter,
  SelectMetadata,
  SelectNotice,
  SelectOption,
  SingleSelectOptions,
} from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";
import { withSpinner } from "#setup/with-spinner.js";

const ADDRESS_PREFIX = "address:";
const BACK = "action:back";
const DONE = "action:done";
const ALL = "category:all";

type RegistryRow = string;
type RegistryCategory = "channel" | "connection" | "extension" | "instrumentation";

const REGISTRY_CATEGORIES: ReadonlyArray<{
  value: `category:${RegistryCategory}`;
  prefix: `${RegistryCategory}/`;
  label: string;
  hint: string;
}> = [
  {
    value: "category:channel",
    prefix: "channel/",
    label: "Chat channels",
    hint: "Web, Slack, Discord, Teams",
  },
  {
    value: "category:connection",
    prefix: "connection/",
    label: "Tools & data",
    hint: "Linear, Notion, GitHub, Vercel",
  },
  {
    value: "category:extension",
    prefix: "extension/",
    label: "Capabilities",
    hint: "Browser automation, memory, developer tools",
  },
  {
    value: "category:instrumentation",
    prefix: "instrumentation/",
    label: "Observability",
    hint: "Sentry, Braintrust, Honeycomb",
  },
];

export interface RegistryFlowDeps {
  browseRegistryCatalog: (typeof import("#cli/commands/registry.js"))["browseRegistryCatalog"];
  getRegistryItemManifest: (typeof import("#cli/commands/registry.js"))["getRegistryItemManifest"];
  installRegistryItem: (typeof import("#cli/commands/registry.js"))["installRegistryItem"];
}

export type RegistryFlowResult =
  | { kind: "done"; addedItems: readonly string[]; output?: readonly string[] }
  | { kind: "cancelled" };

function itemLabel(item: RegistryCatalogItem): string {
  if (item.title !== undefined) return item.title;
  const name = item.name.split("/").at(-1) ?? item.name;
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function itemRows(items: readonly RegistryCatalogItem[]): SelectOption<RegistryRow>[] {
  return items.map((item, index) => ({
    value: `item:${index}`,
    label: itemLabel(item),
    hint: item.description ?? item.type,
  }));
}

function categoryRows(): SelectOption<RegistryRow>[] {
  return [
    ...REGISTRY_CATEGORIES.map((category) => ({
      value: category.value,
      label: category.label,
      hint: category.hint,
    })),
    {
      value: ALL,
      label: "All integrations",
      hint: "Search by name or enter an item address",
    },
    { value: DONE, label: "Back to chat", trailingAction: true },
  ];
}

function itemsForCategory(
  items: readonly RegistryCatalogItem[],
  selectedCategory: RegistryRow,
): readonly RegistryCatalogItem[] {
  if (selectedCategory === ALL) return items;
  const category = REGISTRY_CATEGORIES.find((entry) => entry.value === selectedCategory);
  return category === undefined
    ? items
    : items.filter(
        (item) => item.address.startsWith(category.prefix) || item.name.startsWith(category.prefix),
      );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
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

function summarizeDetails(values: readonly string[], limit = 3): string {
  const visible = values.slice(0, limit);
  const remaining = values.length - visible.length;
  return remaining > 0 ? `${visible.join(", ")} … (+${remaining} more)` : visible.join(", ");
}

function itemDetails(
  item: RegistryCatalogItem,
  manifest: Record<string, unknown>,
): SelectMetadata[] {
  const details: SelectMetadata[] = [{ label: "Source", value: item.source }];
  const dependencies = [
    ...stringArray(manifest.dependencies),
    ...stringArray(manifest.devDependencies),
    ...stringArray(manifest.registryDependencies),
  ];
  if (dependencies.length > 0)
    details.push({ label: "Packages", value: summarizeDetails(dependencies) });
  const envVars = manifest.envVars;
  if (typeof envVars === "object" && envVars !== null && !Array.isArray(envVars)) {
    const names = Object.keys(envVars);
    if (names.length > 0) details.push({ label: "Environment", value: summarizeDetails(names) });
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const targets = files.flatMap((file) => {
    if (typeof file !== "object" || file === null || Array.isArray(file)) return [];
    const target = (file as Record<string, unknown>).target;
    return typeof target === "string" ? [target] : [];
  });
  if (targets.length > 0) details.push({ label: "Files", value: summarizeDetails(targets) });
  return details;
}

async function inspectItem(
  prompter: Prompter,
  deps: RegistryFlowDeps,
  appRoot: string,
  item: RegistryCatalogItem,
  resolvedManifest?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ kind: "added"; output: readonly string[] } | { kind: "back" }> {
  const manifest =
    resolvedManifest ??
    manifestRecord(
      await withSpinner(prompter, "Loading registry item…", () =>
        deps.getRegistryItemManifest(appRoot, item.address),
      ),
    );
  while (true) {
    const request: SingleSelectOptions<string> = {
      message: typeof manifest.title === "string" ? manifest.title : item.name,
      metadata: itemDetails(item, manifest),
      options: [
        { value: "add", label: "Add to project" },
        { value: "back", label: "Back" },
      ],
    };
    const description =
      typeof manifest.description === "string" ? manifest.description : item.description;
    if (description !== undefined) request.description = description;
    const action = await prompter.select(request);
    if (action === "back") return { kind: "back" };
    const spinner = prompter.log.spinner?.(`Installing ${itemLabel(item)} and dependencies…`);
    try {
      spinner?.stop();
      const install = () =>
        deps.installRegistryItem(appRoot, item.address, {
          silent: true,
          prompter,
          signal,
        });
      const output = await (prompter.withExclusiveTerminal?.(install) ?? install());
      return { kind: "added", output };
    } finally {
      spinner?.stop();
    }
  }
}

async function resolveAddressItem(
  prompter: Prompter,
  deps: RegistryFlowDeps,
  appRoot: string,
  address: string,
): Promise<{ item: RegistryCatalogItem; manifest: Record<string, unknown> }> {
  const manifest = await withSpinner(prompter, "Loading registry item…", () =>
    deps.getRegistryItemManifest(appRoot, address),
  );
  const record = manifestRecord(manifest);
  const item: RegistryCatalogItem = {
    address,
    name: typeof record.name === "string" ? record.name : address,
    source: itemSource(address),
  };
  if (typeof record.type === "string") item.type = record.type;
  if (typeof record.description === "string") item.description = record.description;
  return { item, manifest: record };
}

/** Runs the categorized interactive registry catalog used by the dev TUI's `/add`. */
export async function runRegistryFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  deps?: Partial<RegistryFlowDeps>;
}): Promise<RegistryFlowResult> {
  let loaded: typeof import("#cli/commands/registry.js") | undefined;
  if (
    input.deps?.browseRegistryCatalog === undefined ||
    input.deps.getRegistryItemManifest === undefined ||
    input.deps.installRegistryItem === undefined
  ) {
    loaded = await import("#cli/commands/registry.js");
  }
  const deps: RegistryFlowDeps = {
    browseRegistryCatalog: input.deps?.browseRegistryCatalog ?? loaded!.browseRegistryCatalog,
    getRegistryItemManifest: input.deps?.getRegistryItemManifest ?? loaded!.getRegistryItemManifest,
    installRegistryItem: input.deps?.installRegistryItem ?? loaded!.installRegistryItem,
  };
  let notices: SelectNotice[] = [];

  try {
    while (true) {
      input.signal?.throwIfAborted();
      const catalog = await withSpinner(input.prompter, "Loading registry…", () =>
        deps.browseRegistryCatalog(input.appRoot),
      );
      notices = [
        ...notices,
        ...catalog.errors.map((error) => ({
          tone: "warning" as const,
          text: `${error.registry}: ${error.message}`,
        })),
      ];
      const selectedCategory = await input.prompter.select<RegistryRow>({
        message: "",
        options: categoryRows(),
        hintLayout: "inline",
        notices,
      });
      notices = [];
      if (selectedCategory === DONE) return { kind: "done", addedItems: [] };

      const categoryItems = itemsForCategory(catalog.items, selectedCategory);
      const rows = itemRows(categoryItems);
      rows.push({ value: BACK, label: "Back", trailingAction: true });
      const selected = await input.prompter.select<RegistryRow>({
        message: "Browse registry integrations",
        options: rows,
        search: true,
        placeholder: "Search or enter an item address",
        searchAction: {
          label: (query) => `Add “${query}”`,
          value: (query) => `${ADDRESS_PREFIX}${query.trim()}`,
        },
        hintLayout: "inline",
      });
      if (selected === BACK) continue;
      const resolved = selected.startsWith(ADDRESS_PREFIX)
        ? await resolveAddressItem(
            input.prompter,
            deps,
            input.appRoot,
            selected.slice(ADDRESS_PREFIX.length),
          )
        : { item: categoryItems[Number(selected.slice("item:".length))] };
      if (resolved.item === undefined) {
        throw new Error("The selected registry item is no longer available.");
      }
      const inspected = await inspectItem(
        input.prompter,
        deps,
        input.appRoot,
        resolved.item,
        "manifest" in resolved ? resolved.manifest : undefined,
        input.signal,
      );
      if (inspected.kind === "added") {
        return inspected.output.length === 0
          ? { kind: "done", addedItems: [resolved.item.address] }
          : {
              kind: "done",
              addedItems: [resolved.item.address],
              output: inspected.output,
            };
      }
    }
  } catch (error) {
    if (error instanceof WizardCancelledError) return { kind: "cancelled" };
    throw error;
  }
}
