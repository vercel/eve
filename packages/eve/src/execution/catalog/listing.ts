import { isAgentTool } from "#execution/tasks/tool-entry-point.js";
import type { Announcement } from "#harness/announcements.js";

import { compareCodeUnits } from "./rank.js";
import type { StepCatalog } from "./step-catalog.js";

const ANNOUNCEMENT_KEY = "catalog";
const MAX_LISTED_NAMESPACES = 20;
const MAX_LISTED_CONNECTIONS = 20;

/** The kinds of deferred entries, as the header names them. */
type Kind = "tools" | "agents";

interface ListedConnection {
  readonly description: string;
  readonly name: string;
}

/** A list cut at its cap; `more` says it was cut. */
interface Capped<T> {
  readonly items: readonly T[];
  readonly more: boolean;
}

/**
 * Exactly what the listing says, which is what gets recorded. It names no
 * deferred entry, so deferring keeps entries out of context and the listing
 * doesn't grow with the catalog. It counts nothing, so a dynamic resolver
 * adding or dropping an entry doesn't append a message.
 */
interface CatalogListing {
  readonly connections: Capped<ListedConnection>;
  readonly kinds: readonly Kind[];
  readonly namespaces: Capped<string>;
}

/**
 * Announces the catalog: the kinds of deferred entries, their namespaces, and
 * the connections, then the whole listing again whenever that changes.
 * Connection tools stay unlisted, since listing them needs a network call and
 * maybe a sign-in. `announced` holds the values announced so far.
 */
export function catalogAnnouncements(
  catalog: StepCatalog,
  announced: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, Announcement>> {
  const current = listCatalog(catalog);
  // An empty catalog the model never heard of has nothing to announce.
  if (announced?.[ANNOUNCEMENT_KEY] === undefined && isEmpty(current)) return {};
  const reachable = reachableNames(catalog);
  return {
    [ANNOUNCEMENT_KEY]: {
      value: JSON.stringify(current),
      render: (previous) => renderCatalogAnnouncement(parseListing(previous), current, reachable),
    },
  };
}

function listCatalog(catalog: StepCatalog): CatalogListing {
  const deferred = [...catalog.deferred.values()];
  const kinds: Kind[] = [];
  if (deferred.some((definition) => !isAgentTool(definition))) kinds.push("tools");
  if (deferred.some(isAgentTool)) kinds.push("agents");
  // The largest namespaces make the cut, rendered by name, so an entry joining or leaving one
  // only changes the text when it moves a namespace across the cap.
  const namespaces = capped(
    [...namespaceCounts(catalog)]
      .sort(([a, aCount], [b, bCount]) => bCount - aCount || compareCodeUnits(a, b))
      .map(([namespace]) => namespace),
    MAX_LISTED_NAMESPACES,
  );
  const connections = catalog.connections
    .map(({ connectionName, description }) => ({ description, name: connectionName }))
    .sort((a, b) => compareCodeUnits(a.name, b.name));
  return {
    connections: capped(connections, MAX_LISTED_CONNECTIONS),
    kinds,
    namespaces: { ...namespaces, items: [...namespaces.items].sort(compareCodeUnits) },
  };
}

/** How many deferred entries each namespace holds. */
function namespaceCounts(catalog: StepCatalog): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const { name } of catalog.deferred.values()) {
    const namespace = namespaceOf(name);
    if (namespace !== "") counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
  }
  return counts;
}

/**
 * The namespaces and connections the session can still reach, deferred or
 * not: a namespace past the cap, or whose entries stopped being deferred, is
 * not gone.
 */
function reachableNames(catalog: StepCatalog): ReadonlySet<string> {
  return new Set([
    ...[...catalog.entries.keys()].map(namespaceOf),
    ...catalog.connections.map(({ connectionName }) => connectionName),
  ]);
}

/** A name's first `__` segment, or "" when it has none. */
function namespaceOf(name: string): string {
  return name.slice(0, Math.max(0, name.indexOf("__")));
}

function capped<T>(items: readonly T[], max: number): Capped<T> {
  return { items: items.slice(0, max), more: items.length > max };
}

function renderCatalogAnnouncement(
  previous: CatalogListing | undefined,
  current: CatalogListing,
  reachable: ReadonlySet<string>,
): string {
  if (isEmpty(current)) return "The catalog changed. It is empty now; do not call execute.";
  if (previous === undefined || isEmpty(previous)) return renderListing(current);
  const gone = [
    ...previous.namespaces.items,
    ...previous.connections.items.map(({ name }) => name),
  ].filter((name) => !reachable.has(name));
  return [
    "The catalog changed.",
    renderListing(current),
    ...(gone.length > 0 ? [`No longer available: ${gone.join(", ")}`] : []),
  ].join("\n");
}

function renderListing({ connections, kinds, namespaces }: CatalogListing): string {
  const subject =
    kinds.length === 0
      ? "Your connections have more tools"
      : `You have more ${kinds.join(" and ")}`;
  const lines = [
    `${subject} than are loaded here. Before saying you have no tool for a task, look for one with search, which searches your own catalog, not the web. Call them with execute({ tool, input }).`,
  ];
  if (namespaces.items.length > 0) {
    const listed = [...namespaces.items, ...(namespaces.more ? ["and more"] : [])];
    lines.push(
      `Namespaces, whose entries are named <namespace>__<name>; search one with "<namespace>__": ${listed.join(", ")}`,
    );
  }
  if (connections.items.length > 0) {
    lines.push(
      'Connections, whose tools are named <connection>__<tool>; search one connection\'s tools with "<connection>__":',
      ...connections.items.map(formatConnection),
      ...(connections.more ? ["- and more"] : []),
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
  return listing.kinds.length === 0 && listing.connections.items.length === 0;
}

/** The recorded listing; a value that isn't JSON counts as none. */
function parseListing(value: string | undefined): CatalogListing | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as CatalogListing;
  } catch {
    return undefined;
  }
}
