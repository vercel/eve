import { expect, it } from "vitest";
import { inMemory } from "#public/memory/file/backends/in-memory.js";
import { connectionEventStore } from "#runtime/connections/events/store.js";
import type { EventBinding } from "#runtime/connections/events/state.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

const owner = { principalKey: "account", executionPrincipal: "alice" };
const binding: EventBinding = {
  ...owner,
  id: "watch",
  sessionId: "origin",
  connectionName: "issues",
  instanceId: undefined,
  connector: "issues",
  auth: null,
  request: {
    name: "issue.created",
    arguments: {},
    expiresAt: null,
    idempotencyKey: "watch",
  },
};

function connection(): ResolvedConnectionDefinition {
  return {
    connectionName: "issues",
    description: "Issue events",
    protocol: "mcp",
    sourceKind: "module",
    sourceId: "issues",
    logicalPath: "connections/issues.ts",
    url: "https://example.com/mcp",
    experimental_events: { storage: inMemory(), onEvent() {} },
  };
}

it("preserves concurrent subscription creations", async () => {
  const store = connectionEventStore(connection(), owner);
  await Promise.all([store.save(binding), store.save({ ...binding, id: "second" })]);
  expect(Object.keys(await store.list()).sort()).toEqual(["second", "watch"]);
});

it("does not reactivate a retired watch when a stale writer retries", async () => {
  const store = connectionEventStore(connection(), owner);
  await store.save(binding);
  const retirement = { retired: true as const, terminationDeliveryId: "terminated-1" };
  await Promise.all([store.save({ ...binding, ...retirement }), store.save(binding)]);
  expect((await store.list()).watch).toMatchObject(retirement);
  expect(await store.save(binding)).toMatchObject(retirement);
});

it("scopes the registry to both principals and the authored connection", async () => {
  const definition = connection();
  await connectionEventStore(definition, owner).save(binding);
  for (const other of [
    { ...owner, executionPrincipal: "bob" },
    { ...owner, principalKey: "other-account" },
  ])
    expect(await connectionEventStore(definition, other).list()).toEqual({});
  expect(
    await connectionEventStore({ ...definition, connectionName: "other" }, owner).list(),
  ).toEqual({});
});
