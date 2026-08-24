import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { serializeCompiledManifestForFingerprint } from "#internal/compiled-manifest-fingerprint.js";
import {
  createStubCompiledAgentManifest as createCompiledAgentManifest,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";

function manifestWithRoot(runtimeAppRoot: string, agentRoot = join(runtimeAppRoot, "agent")) {
  return createCompiledAgentManifest({
    kernelPlan: { prepared: [] },
    agentRoot,
    appRoot: runtimeAppRoot,
    bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
    config: {
      model: { id: "openai/gpt-5-mini", routing: { kind: "gateway", target: "openai" } },
      name: "fingerprint-test",
      source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
    },
  });
}

describe("serializeCompiledManifestForFingerprint", () => {
  it("serializes identical content under different snapshot roots identically", () => {
    const firstRoot = "/tmp/snapshots/generation-a/source/app";
    const secondRoot = "/tmp/snapshots/generation-b/source/app";
    const first = serializeCompiledManifestForFingerprint({
      manifest: manifestWithRoot(firstRoot),
      runtimeAppRoot: firstRoot,
    });
    const second = serializeCompiledManifestForFingerprint({
      manifest: manifestWithRoot(secondRoot),
      runtimeAppRoot: secondRoot,
    });

    expect(first).toBe(second);
    expect(first).toContain("$runtime/agent");
    expect(first).not.toContain("generation-a");
  });

  it("keeps absolute paths outside the runtime root verbatim", () => {
    const runtimeAppRoot = "/tmp/snapshots/generation-a/source/app";
    const serialized = serializeCompiledManifestForFingerprint({
      manifest: manifestWithRoot(runtimeAppRoot, "/somewhere/else/agent"),
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
