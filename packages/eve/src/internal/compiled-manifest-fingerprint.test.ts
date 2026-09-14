import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import { serializeCompiledManifestForFingerprint } from "#internal/compiled-manifest-fingerprint.js";

async function manifestWithRoot(runtimeAppRoot: string, agentRoot = join(runtimeAppRoot, "agent")) {
  return (
    await compileFromMemory({
      agentRoot,
      appRoot: runtimeAppRoot,
      model: "openai/gpt-5.4",
      name: "fingerprint-test",
      revision: "fingerprint-test:v1",
    })
  ).manifest;
}

describe("serializeCompiledManifestForFingerprint", () => {
  it("serializes identical content under different snapshot roots identically", async () => {
    const firstRoot = "/tmp/snapshots/generation-a/source/app";
    const secondRoot = "/tmp/snapshots/generation-b/source/app";
    const first = serializeCompiledManifestForFingerprint({
      manifest: await manifestWithRoot(firstRoot),
      runtimeAppRoot: firstRoot,
    });
    const second = serializeCompiledManifestForFingerprint({
      manifest: await manifestWithRoot(secondRoot),
      runtimeAppRoot: secondRoot,
    });

    expect(first).toBe(second);
    expect(first).toContain("$runtime/agent");
    expect(first).not.toContain("generation-a");
  });

  it("keeps absolute paths outside the runtime root verbatim", async () => {
    const runtimeAppRoot = "/tmp/snapshots/generation-a/source/app";
    const serialized = serializeCompiledManifestForFingerprint({
      manifest: await manifestWithRoot(runtimeAppRoot, "/somewhere/else/agent"),
      runtimeAppRoot,
    });

    expect(serialized).toContain("/somewhere/else/agent");
  });

  it("canonicalizes object key order", () => {
    const left = serializeCompiledManifestForFingerprint({
      manifest: { agentRoot: "/app/agent", config: { model: "m", name: "n" } } as never,
      runtimeAppRoot: "/app",
    });
    const right = serializeCompiledManifestForFingerprint({
      manifest: { config: { name: "n", model: "m" }, agentRoot: "/app/agent" } as never,
      runtimeAppRoot: "/app",
    });

    expect(left).toBe(right);
  });
});
