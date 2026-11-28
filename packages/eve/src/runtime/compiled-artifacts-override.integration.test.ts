import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { symlink } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import {
  installCompiledArtifactsOverride,
  materializeCompiledArtifactsSource,
  readCompiledArtifactsOverride,
} from "#runtime/compiled-artifacts-override.js";
import type { RuntimeDiskCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import { resolveNitroChannelRuntimeBundle } from "#internal/nitro/routes/runtime-stack.js";

const createScratchDirectory = useTemporaryDirectories();
const OVERRIDE_KEY = Symbol.for("eve.compiledArtifactsOverride");

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[OVERRIDE_KEY];
});

async function compileFixtureApp(): Promise<{ appRoot: string; stash: string }> {
  const appRoot = await createScratchDirectory("eve-override-app-");
  const stash = await createScratchDirectory("eve-override-stash-");
  await mkdir(join(appRoot, "agent"), { recursive: true });
  await mkdir(join(appRoot, "node_modules"), { recursive: true });
  await writeFile(join(appRoot, "package.json"), '{"name":"override-agent","type":"module"}\n');
  await symlink(resolve(import.meta.dirname, "../.."), join(appRoot, "node_modules", "eve"));
  await writeFile(
    join(appRoot, "agent", "agent.ts"),
    'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4-mini" });\n',
  );
  await writeFile(join(appRoot, "agent", "instructions.md"), "Be brief.\n");
  await compileAgent({ startPath: appRoot });
  await cp(join(appRoot, ".eve", "compile"), join(stash, "compile"), { recursive: true });
  return { appRoot, stash };
}

describe("compiled artifacts override", () => {
  it("ignores sources without a materialization reference", async () => {
    const materialize = vi.fn();
    installCompiledArtifactsOverride({ materialize, resolve: () => undefined });

    await materializeCompiledArtifactsSource({ appRoot: "/nowhere", kind: "disk" });
    await materializeCompiledArtifactsSource({ kind: "bundled" });

    expect(materialize).not.toHaveBeenCalled();
  });

  it("fails loudly when a source needs a materializer and none is installed", async () => {
    expect(readCompiledArtifactsOverride()).toBeUndefined();
    await expect(
      materializeCompiledArtifactsSource({
        appRoot: "/nowhere",
        kind: "disk",
        materializationRef: "ws@v1",
      }),
    ).rejects.toThrow('"ws@v1" need a materializer');
  });

  it("restores wiped artifacts before a durable step reloads the bundle", async () => {
    const { appRoot, stash } = await compileFixtureApp();
    const materialize = vi.fn(async (source: RuntimeDiskCompiledArtifactsSource) => {
      await rm(join(source.appRoot, ".eve", "compile"), { force: true, recursive: true });
      await cp(join(stash, "compile"), join(source.appRoot, ".eve", "compile"), {
        recursive: true,
      });
    });
    installCompiledArtifactsOverride({ materialize, resolve: () => undefined });
    const source: RuntimeDiskCompiledArtifactsSource = {
      appRoot,
      kind: "disk",
      materializationRef: "ws@v1",
    };

    await rm(join(appRoot, ".eve"), { force: true, recursive: true });

    const bundle = await withRuntimeSession(createRuntimeSession("after-wipe"), () =>
      getCompiledRuntimeAgentBundle({ compiledArtifactsSource: source }),
    );

    expect(materialize).toHaveBeenCalledWith(
      expect.objectContaining({ materializationRef: "ws@v1" }),
    );
    expect(bundle.resolvedAgent.config?.name).toBeDefined();
  });

  it("does not load a wiped source that has no materialization reference", async () => {
    const { appRoot } = await compileFixtureApp();
    await rm(join(appRoot, ".eve"), { force: true, recursive: true });

    await expect(
      withRuntimeSession(createRuntimeSession("no-ref"), () =>
        getCompiledRuntimeAgentBundle({ compiledArtifactsSource: { appRoot, kind: "disk" } }),
      ),
    ).rejects.toThrow();
  });

  it("runs the request on the source the override resolves", async () => {
    const { appRoot } = await compileFixtureApp();
    const source: RuntimeDiskCompiledArtifactsSource = { appRoot, kind: "disk" };
    const seen: string[] = [];
    installCompiledArtifactsOverride({
      materialize: async () => {},
      resolve: (request) => {
        seen.push(request.headers.get("x-workspace") ?? "");
        return request.headers.get("x-workspace") === "custom" ? source : undefined;
      },
    });
    const config = { kind: "production", sandboxScope: "test" } as const;

    const custom = await withRuntimeSession(createRuntimeSession("route"), () =>
      resolveNitroChannelRuntimeBundle(
        config,
        new Request("https://x.test/", { headers: { "x-workspace": "custom" } }),
      ),
    );

    expect(custom.compiledArtifactsSource).toEqual(source);
    expect(seen).toEqual(["custom"]);
  });
});
