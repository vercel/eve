import { describe, expect, it } from "vitest";
import { ContextContainer } from "#context/container.js";
import type { HistoryState } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { announceConnections } from "#execution/connection-announcement.js";
import { getPendingAnnouncements } from "#harness/announcements.js";
import { createCurrentMessages } from "#harness/current-messages.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

function registryOf(connections: Record<string, string>): ConnectionRegistry {
  const resolved = Object.entries(connections).map(
    ([connectionName, description]) =>
      ({ connectionName, description }) as ResolvedConnectionDefinition,
  );
  return {
    dispose: async () => {},
    getClient: () => {
      throw new Error("unused");
    },
    getConnectionApproval: () => undefined,
    getConnectionNames: () => resolved.map((connection) => connection.connectionName),
    getConnections: () => resolved,
  };
}

/** Runs one step's announcement pass and returns the messages it appended. */
function step(
  connections: Record<string, string>,
  state: { history: HarnessModelMessage[]; historyState?: HistoryState },
): string[] {
  const ctx = new ContextContainer();
  ctx.set(ConnectionRegistryKey, registryOf(connections));
  announceConnections(ctx);
  const current = createCurrentMessages(state.history, { historyState: state.historyState });
  current.addAnnouncements({ keyed: getPendingAnnouncements(ctx) });
  const appended = current.history.slice(state.history.length);
  state.history = [...current.history];
  state.historyState = current.historyState;
  return appended.map((message) => String(message.content));
}

describe("connection announcements", () => {
  it("appends a baseline, then only changes, and rebaselines after compaction", () => {
    const state: { history: HarnessModelMessage[]; historyState?: HistoryState } = {
      history: [],
    };

    expect(step({}, state)).toEqual([]);
    expect(step({ linear: "Linear issues" }, state)).toEqual([
      [
        "Connections. Find their tools with connection_search and call them with connection_execute.",
        "- linear: Linear issues",
      ].join("\n"),
    ]);
    expect(step({ linear: "Linear issues" }, state)).toEqual([]);
    expect(step({ github: "GitHub repositories" }, state)).toEqual([
      [
        "Connections changed.",
        "Added or updated:",
        "- github: GitHub repositories",
        "No longer available, do not call: linear",
      ].join("\n"),
    ]);

    // Compaction replaces history and clears the announcement record.
    const compacted = { history: [], historyState: undefined };
    expect(step({ github: "GitHub repositories" }, compacted)).toEqual([
      [
        "Connections. Find their tools with connection_search and call them with connection_execute.",
        "- github: GitHub repositories",
      ].join("\n"),
    ]);
  });
});
