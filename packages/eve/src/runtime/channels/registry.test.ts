import { describe, expect, it } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { HTTP_ADAPTER, HTTP_ADAPTER_KIND } from "#channel/http.js";
import { SCHEDULE_ADAPTER, SCHEDULE_ADAPTER_KIND } from "#channel/schedule.js";
import { SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter.js";
import { SUBAGENT_ADAPTER } from "#execution/subagent-adapter.js";
import { RuntimeRegistryError } from "#internal/runtime-registry.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import {
  createRuntimeAdapterRegistry,
  deserializeRuntimeAdapter,
} from "#runtime/channels/registry.js";

function makeChannelDefinition(
  adapter: ChannelAdapter | undefined,
  overrides: Partial<ResolvedChannelDefinition> = {},
): ResolvedChannelDefinition {
  return {
    adapter,
    fetch: async () => new Response(null),
    logicalPath: "channels/test.ts",
    method: "POST",
    name: "test",
    sourceId: "channels/test",
    sourceKind: "module",
    urlPath: "/eve/test",
    ...overrides,
  };
}

describe("createRuntimeAdapterRegistry", () => {
  describe("framework adapters", () => {
    it("registers http, subagent, and schedule framework adapters by default", () => {
      const registry = createRuntimeAdapterRegistry({ channels: [] });

      expect(registry.adaptersByKind.get(HTTP_ADAPTER_KIND)).toBe(HTTP_ADAPTER);
      expect(registry.adaptersByKind.get(SUBAGENT_ADAPTER_KIND)).toBe(SUBAGENT_ADAPTER);
      expect(registry.adaptersByKind.get(SCHEDULE_ADAPTER_KIND)).toBe(SCHEDULE_ADAPTER);
    });

    // The kind discriminator is locked at the literal "http" because
    // it is persisted into durable workflow state
    // (`serializedContext["eve.channel"].kind`). Renaming the value
    // would break rehydration for every in-flight session started
    // under any prior build. This assertion exists to make that
    // contract impossible to silently violate via a refactor.
    it('locks the HTTP framework adapter kind value at the literal "http"', () => {
      expect(HTTP_ADAPTER_KIND).toBe("http");
      expect(HTTP_ADAPTER).toEqual({ kind: "http" });
    });

    // Regression: pre-fix, the runtime threw "Unknown adapter kind:
    // \"schedule\"" at the first workflow step boundary for every
    // channel-less schedule (i.e. every markdown schedule, which is
    // forbidden from declaring a channel). Locks the framework
    // registration so that rehydrating a serialized schedule adapter
    // returns the bare discriminator instead of throwing.
    it("rehydrates a serialized schedule adapter through the framework registry", () => {
      const registry = createRuntimeAdapterRegistry({ channels: [] });

      const rehydrated = deserializeRuntimeAdapter(registry, {
        kind: SCHEDULE_ADAPTER_KIND,
        state: {},
      });

      expect(rehydrated).toEqual({ kind: SCHEDULE_ADAPTER_KIND, state: {} });
    });

    // Mirror of the schedule rehydration regression — proves the
    // canonical session channel adapter survives a workflow step
    // boundary round-trip through the durable wire shape.
    it("rehydrates a serialized HTTP adapter through the framework registry", () => {
      const registry = createRuntimeAdapterRegistry({ channels: [] });

      const rehydrated = deserializeRuntimeAdapter(registry, {
        kind: HTTP_ADAPTER_KIND,
        state: {},
      });

      expect(rehydrated).toEqual({ kind: HTTP_ADAPTER_KIND, state: {} });
    });
  });

  describe("route-declared adapters sharing a framework kind", () => {
    it("silently merges a bare pass-through that re-declares a framework kind", () => {
      const registry = createRuntimeAdapterRegistry({
        channels: [makeChannelDefinition({ kind: "http" })],
      });

      // Framework adapter wins — a bare pass-through contributes no
      // behavior, so the registry keeps the framework entry.
      expect(registry.adaptersByKind.get("http")).toEqual({ kind: "http" });
    });

    it("rejects a route-declared subagent adapter that carries an input.requested handler", () => {
      const offendingAdapter: ChannelAdapter = {
        kind: SUBAGENT_ADAPTER_KIND,
        "input.requested": async () => undefined,
      };

      expect(() =>
        createRuntimeAdapterRegistry({
          channels: [
            makeChannelDefinition(offendingAdapter, {
              logicalPath: "channels/sneaky.ts",
              sourceId: "channels/sneaky",
            }),
          ],
        }),
      ).toThrow(RuntimeRegistryError);
    });

    it("surfaces the offending route's source location on the rejection", () => {
      const offendingAdapter: ChannelAdapter = {
        kind: SUBAGENT_ADAPTER_KIND,
        "input.requested": async () => undefined,
      };

      try {
        createRuntimeAdapterRegistry({
          channels: [
            makeChannelDefinition(offendingAdapter, {
              logicalPath: "channels/sneaky.ts",
              sourceId: "channels/sneaky",
            }),
          ],
        });
        throw new Error("expected createRuntimeAdapterRegistry to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimeRegistryError);
        const registryError = error as RuntimeRegistryError;
        expect(registryError.registry).toBe("adapter");
        expect(registryError.entryName).toBe(SUBAGENT_ADAPTER_KIND);
        expect(registryError.logicalPath).toBe("channels/sneaky.ts");
        expect(registryError.sourceId).toBe("channels/sneaky");
        expect(registryError.message).toMatch(/framework|reserved|pass-through/);
      }
    });

    it("rejects a route-declared http adapter that adds a deliver hook", () => {
      const offendingAdapter: ChannelAdapter = {
        kind: "http",
        deliver: () => undefined,
      };

      expect(() =>
        createRuntimeAdapterRegistry({
          channels: [makeChannelDefinition(offendingAdapter)],
        }),
      ).toThrow(RuntimeRegistryError);
    });

    it("rejects a route-declared http adapter that adds a fetchFile function", () => {
      const offendingAdapter: ChannelAdapter = {
        kind: "http",
        fetchFile: async (_url: string) => Buffer.alloc(0),
      };

      expect(() =>
        createRuntimeAdapterRegistry({
          channels: [makeChannelDefinition(offendingAdapter)],
        }),
      ).toThrow(RuntimeRegistryError);
    });

    it("rejects a route-declared http adapter that adds a createAdapterContext factory", () => {
      const offendingAdapter: ChannelAdapter = {
        kind: "http",
        createAdapterContext(base) {
          return base;
        },
      };

      expect(() =>
        createRuntimeAdapterRegistry({
          channels: [makeChannelDefinition(offendingAdapter)],
        }),
      ).toThrow(RuntimeRegistryError);
    });
  });

  describe("route-declared adapters with non-framework kinds", () => {
    it("registers a route-declared adapter with a custom kind", () => {
      const customAdapter: ChannelAdapter = {
        kind: "slack",
        deliver: () => undefined,
      };

      const registry = createRuntimeAdapterRegistry({
        channels: [makeChannelDefinition(customAdapter)],
      });

      expect(registry.adaptersByKind.get("slack")).toBe(customAdapter);
    });

    it("rejects a route-declared adapter missing a kind field", () => {
      // Simulate broken authored input that bypasses TypeScript typing.
      const bogusAdapter = {} as ChannelAdapter;

      expect(() =>
        createRuntimeAdapterRegistry({
          channels: [makeChannelDefinition(bogusAdapter)],
        }),
      ).toThrow(RuntimeRegistryError);
    });
  });
});
