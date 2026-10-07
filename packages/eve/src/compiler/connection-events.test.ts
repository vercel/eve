import { expect, it, vi } from "vitest";
import { normalizeMcpClientConnectionDefinition } from "#internal/authored-definition/connection.js";
import { normalizeAuthorizationSpec } from "#shared/validate-authorization.js";
import { extractVercelConnectMetadata } from "#shared/vercel-connect-metadata.js";
import { resolveDynamicConnectionValue } from "#runtime/resolve-connection.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";

const backend = { createAdapter: vi.fn(), verify: vi.fn() };
const auth = {
  getToken: async () => ({ token: "credential" }),
  vercelConnect: {
    connector: "oauth/issues",
    experimental_events: backend,
  },
};
const definition = { auth, description: "Issue events", url: "https://issues.example/mcp" };

it("preserves the runtime bridge through repeated auth normalization but excludes it from build metadata", () => {
  const normalized = normalizeAuthorizationSpec(normalizeAuthorizationSpec(auth, "test"), "test");
  expect(normalized.vercelConnect?.experimental_events).toBe(backend);
  expect(extractVercelConnectMetadata(normalized.vercelConnect)).toEqual({
    connector: "oauth/issues",
  });
  expect(backend.createAdapter).not.toHaveBeenCalled();
});

it.each([
  { experimental_events: true },
  { experimental_events: {} },
  { experimental_events: { onEvent() {}, onGap: true } },
  { auth: { getToken: auth.getToken }, experimental_events: { onEvent() {} } },
  { auth: () => auth, experimental_events: { onEvent() {} } },
])(
  "rejects event configurations without callbacks and a static events-capable provider: %j",
  (override) => {
    expect(() =>
      normalizeMcpClientConnectionDefinition({ ...definition, ...override }, "issues"),
    ).toThrow();
  },
);

it("accepts separate event/lifecycle callbacks without invoking them or allocating a subscription", () => {
  const onEvent = vi.fn();
  const callbacks = { onEvent, onGap: vi.fn(), onTerminated: vi.fn() };
  const normalized = normalizeMcpClientConnectionDefinition(
    { ...definition, experimental_events: callbacks },
    "issues",
  );
  expect(normalized.experimental_events).toEqual(callbacks);
  expect(onEvent).not.toHaveBeenCalled();
  expect(backend.createAdapter).not.toHaveBeenCalled();
  expect(
    normalizeMcpClientConnectionDefinition(definition, "issues").experimental_events,
  ).toBeUndefined();
});

it("rejects events on dynamic connections whose receiver cannot be mounted at build time", () => {
  const value = defineMcpClientConnection({
    ...definition,
    instanceKey: "issues",
    experimental_events: { onEvent() {} },
  });
  expect(() =>
    resolveDynamicConnectionValue(value, {
      connectionName: "issues",
      sourceId: "issues",
      sourceKind: "module",
      logicalPath: "connections/issues.ts",
    }),
  ).toThrow("statically authored");
});
