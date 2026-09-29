import type { ContextContainer } from "#context/container.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { setPendingAnnouncement } from "#harness/announcements.js";

const ANNOUNCEMENT_KEY = "connections";

interface ListedConnection {
  readonly description: string;
  readonly name: string;
}

/**
 * Announces the agent's connections for the current step: a baseline listing
 * the first time, then only what changed. Tool names and signatures stay out
 * of the listing; `connection_search` returns them.
 */
export function announceConnections(ctx: ContextContainer): void {
  const registry = ctx.get(ConnectionRegistryKey);
  if (registry === undefined) {
    setPendingAnnouncement(ctx, ANNOUNCEMENT_KEY, undefined);
    return;
  }
  const current = registry
    .getConnections()
    .map((connection) => ({
      description: connection.description,
      name: connection.connectionName,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  setPendingAnnouncement(ctx, ANNOUNCEMENT_KEY, {
    value: JSON.stringify(current),
    render: (previous) => renderConnectionsAnnouncement(parseListing(previous), current),
  });
}

function renderConnectionsAnnouncement(
  previous: readonly ListedConnection[] | undefined,
  current: readonly ListedConnection[],
): string | undefined {
  // An empty listing was recorded without a message, so the model has not
  // seen the baseline yet.
  if (previous === undefined || previous.length === 0) {
    return current.length === 0 ? undefined : renderListing(current);
  }
  if (current.length === 0) {
    return "Connections changed. No connections are available now; do not call connection_execute.";
  }

  const previousByName = new Map(previous.map((entry) => [entry.name, entry]));
  const currentNames = new Set(current.map((entry) => entry.name));
  const added = current.filter(
    (entry) => previousByName.get(entry.name)?.description !== entry.description,
  );
  const removed = previous.filter((entry) => !currentNames.has(entry.name));
  const parts = ["Connections changed."];
  if (added.length > 0) parts.push(["Added or updated:", ...added.map(formatEntry)].join("\n"));
  if (removed.length > 0) {
    parts.push(
      `No longer available, do not call: ${removed.map((entry) => entry.name).join(", ")}`,
    );
  }
  const delta = parts.join("\n");
  const replacement = `Connections changed. This list replaces the previous one.\n${renderListing(current)}`;
  return delta.length < replacement.length ? delta : replacement;
}

function renderListing(connections: readonly ListedConnection[]): string {
  return [
    "Connections. Find their tools with connection_search and call them with connection_execute.",
    ...connections.map(formatEntry),
  ].join("\n");
}

function formatEntry(entry: ListedConnection): string {
  return entry.description.length === 0
    ? `- ${entry.name}`
    : `- ${entry.name}: ${entry.description}`;
}

function parseListing(value: string | undefined): readonly ListedConnection[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as ListedConnection[]) : undefined;
  } catch {
    return undefined;
  }
}
