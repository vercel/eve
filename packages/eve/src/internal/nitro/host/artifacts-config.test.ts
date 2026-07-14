import { describe, expect, it } from "vitest";

import { createDevelopmentNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import { serializeDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";

describe("development artifacts durable strategy", () => {
  it("stores logical generation selectors when the parent owns the World", () => {
    const config = createDevelopmentNitroArtifactsConfig({
      appRoot: "/tmp/eve-test-app",
    });

    const source = resolveNitroCompiledArtifactsSource(config);
    expect(serializeDurableCompiledArtifactsSource(source)).toEqual({ kind: "development" });
  });

  it("treats an explicitly local World as parent-owned", () => {
    const config = createDevelopmentNitroArtifactsConfig({
      appRoot: "/tmp/eve-test-app",
      configuredWorld: "local",
    });

    const source = resolveNitroCompiledArtifactsSource(config);
    expect(serializeDurableCompiledArtifactsSource(source)).toEqual({ kind: "development" });
  });

  it("pins custom-World payloads to their exact snapshot", () => {
    const config = createDevelopmentNitroArtifactsConfig({
      appRoot: "/tmp/eve-test-app",
      configuredWorld: "@workflow/world-postgres",
    });

    // A custom World's deliveries never install eve's generation context,
    // so the durable payload must be resolvable without it.
    const source = resolveNitroCompiledArtifactsSource(config);
    const durable = serializeDurableCompiledArtifactsSource(source);
    expect(durable).toBe(source);
  });
});
