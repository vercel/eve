import { describe, expect, it, vi } from "vitest";

import type { CompiledModuleMap } from "#compiler/module-map.js";
import type { CompiledReceiveOnlyChannelDefinition } from "#compiler/manifest.js";
import { defineChannel } from "#public/definitions/channel.js";
import { resolveChannelDefinition } from "#runtime/resolve-channel.js";

const mocks = vi.hoisted(() => ({
  loadResolvedModuleExport: vi.fn(),
}));

vi.mock("#runtime/resolve-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#runtime/resolve-helpers.js")>()),
  loadResolvedModuleExport: mocks.loadResolvedModuleExport,
}));

describe("resolveChannelDefinition", () => {
  it("resolves a receive-only channel without fabricating a network route", async () => {
    const authored = defineChannel({
      routes: [],
      async receive(input, { send }) {
        return await send(input.message, {
          auth: input.auth,
          continuationToken: "learning",
          mode: "task",
        });
      },
    });
    mocks.loadResolvedModuleExport.mockResolvedValue(authored);
    const definition = {
      adapterKind: "http",
      kind: "receive-only-channel",
      logicalPath: "channels/learning.ts",
      name: "learning",
      sourceId: "channels/learning.ts",
      sourceKind: "module",
    } satisfies CompiledReceiveOnlyChannelDefinition;

    const resolved = await resolveChannelDefinition(definition, {} as CompiledModuleMap, undefined);

    expect(resolved).toMatchObject({
      adapter: expect.objectContaining({ kind: "http" }),
      definition: authored,
      logicalPath: "channels/learning.ts",
      name: "learning",
      receive: authored.receive,
      sourceId: "channels/learning.ts",
      sourceKind: "module",
    });
    expect(resolved.method).toBeUndefined();
    expect(resolved.urlPath).toBeUndefined();
    expect(resolved.fetch).toBeUndefined();
  });
});
