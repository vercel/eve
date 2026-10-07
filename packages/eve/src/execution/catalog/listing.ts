import { isAgentTool } from "#execution/tasks/tool-entry-point.js";
import type { Announcement } from "#harness/announcements.js";

import { compareCodeUnits } from "./rank.js";
import type { StepCatalog } from "./step-catalog.js";

interface ListedConnection {
  readonly description: string;
  readonly name: string;
}

/** What the model is told the catalog holds. Every group is sorted by name. */
interface CatalogListing {
  readonly agents: readonly string[];
  readonly connections: readonly ListedConnection[];
  readonly tools: readonly string[];
}

const NAME_GROUPS = [
  ["tools", "Tools"],
  ["agents", "Agents"],
] as const;

const ANNOUNCEMENT_KEY = "catalog";

/**
 * Announces the catalog: a baseline listing once it has entries, then only
 * what changed. Names only; descriptions and signatures come from `search`.
 * Connection tools stay unlisted, since listing them needs a network call
 * and maybe a sign-in. `announced` holds the values announced so far.
 */
export function catalogAnnouncements(
  catalog: StepCatalog,
  announced: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, Announcement>> {
  const current = listCatalog(catalog);
  // An empty catalog the model never heard of has nothing to announce.
  if (announced?.[ANNOUNCEMENT_KEY] === undefined && isEmpty(current)) return {};
  return {
    [ANNOUNCEMENT_KEY]: {
      value: JSON.stringify(current),
      render: (previous) => renderCatalogAnnouncement(parseListing(previous), current),
    },
  };
}

function listCatalog(catalog: StepCatalog): CatalogListing {
  const deferred = [...catalog.deferred.values()];
  const names = (agents: boolean) =>
    deferred
      .filter((definition) => isAgentTool(definition) === agents)
      .map((definition) => definition.name)
      .sort();
  return {
    agents: names(true),
    connections: catalog.connections
      .map((connection) => ({
        description: connection.description,
        name: connection.connectionName,
      }))
      .sort((a, b) => compareCodeUnits(a.name, b.name)),
    tools: names(false),
  };
}

function renderCatalogAnnouncement(
  previous: CatalogListing | undefined,
  current: CatalogListing,
): string {
  // After an empty listing, the model has no entries to compare against.
  if (previous === undefined || isEmpty(previous)) return renderListing(current);
  if (isEmpty(current)) {
    return "The catalog changed. It is empty now; do not call execute.";
  }

  const parts = ["The catalog changed."];
  const removed: string[] = [];
  for (const [key, label] of NAME_GROUPS) {
    const before = new Set(previous[key]);
    const after = new Set(current[key]);
    const added = current[key].filter((name) => !before.has(name));
    if (added.length > 0) parts.push(`${label} added: ${added.join(", ")}`);
    removed.push(...previous[key].filter((name) => !after.has(name)));
  }
  const previousConnections = new Map(previous.connections.map((entry) => [entry.name, entry]));
  const currentConnections = new Set(current.connections.map((entry) => entry.name));
  const changedConnections = current.connections.filter(
    (entry) => previousConnections.get(entry.name)?.description !== entry.description,
  );
  if (changedConnections.length > 0) {
    parts.push(
      ["Connections added or updated:", ...changedConnections.map(formatConnection)].join("\n"),
    );
  }
  removed.push(
    ...previous.connections
      .filter((entry) => !currentConnections.has(entry.name))
      .map((entry) => entry.name),
  );
  if (removed.length > 0) parts.push(`No longer available, do not call: ${removed.join(", ")}`);

  const delta = parts.join("\n");
  const replacement = `The catalog changed. This list replaces the previous one.\n${renderListing(current)}`;
  return delta.length < replacement.length ? delta : replacement;
}

function renderListing(listing: CatalogListing): string {
  const lines = [
    "More tools are available than your tool list shows. Find them with search and call them with execute({ tool, input }).",
  ];
  for (const [key, label] of NAME_GROUPS) {
    if (listing[key].length > 0) lines.push(`${label}: ${listing[key].join(", ")}`);
  }
  if (listing.connections.length > 0) {
    lines.push(
      'Connections, whose tools are named <connection>__<tool>; search one connection\'s tools with "<connection>__":',
      ...listing.connections.map(formatConnection),
    );
  }
  return lines.join("\n");
}

function formatConnection(entry: ListedConnection): string {
  return entry.description.length === 0
    ? `- ${entry.name}`
    : `- ${entry.name}: ${entry.description}`;
}

function isEmpty(listing: CatalogListing): boolean {
  return (
    listing.tools.length === 0 && listing.agents.length === 0 && listing.connections.length === 0
  );
}

function parseListing(value: string | undefined): CatalogListing | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as CatalogListing)
      : undefined;
  } catch {
    return undefined;
  }
}
