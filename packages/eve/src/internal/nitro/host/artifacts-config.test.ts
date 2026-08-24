import { describe, expect, it } from "vitest";

import { createDevelopmentNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import { serializeDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";

describe("development artifacts durable strategy", () => {
  it("stores logical generation selectors when the parent owns the World", () => {
    const config = createDevelopmentNitroArtifactsConfig({
      appRoot: "/tmp/eve-test-app",
      worldPlan: { kind: "native", selection: "host-default", target: "local" },
    });

    const source = resolveNitroCompiledArtifactsSource(config);
    expect(serializeDurableCompiledArtifactsSource(source)).toEqual({ kind: "development" });
  });

  it("treats an explicitly local World as parent-owned", () => {
    const config = createDevelopmentNitroArtifactsConfig({
      appRoot: "/tmp/eve-test-app",
      worldPlan: { kind: "native", selection: "configured", target: "local" },
    });

    const source = resolveNitroCompiledArtifactsSource(config);
    expect(serializeDurableCompiledArtifactsSource(source)).toEqual({ kind: "development" });
  });

  it("pins custom-World payloads to their exact snapshot", () => {
    const config = createDevelopmentNitroArtifactsConfig({
      appRoot: "/tmp/eve-test-app",
      worldPlan: {
        backing: {
          entryPackageId: "root",
          entryPath: "/tmp/eve-test-app/node_modules/@workflow/world-postgres/index.js",
          identitySha256: "0".repeat(64),
          mode: "materialized",
          packages: [],
        },
        kind: "host-module",
        packageName: "@workflow/world-postgres",
        protocol: {
          declaredPackageName: "@workflow/core",
          declaredRange: "^5.0.0-beta.43",
          expectedVersion: "5.0.0-beta.43",
        },
        selection: "configured",
      },
    });

    // A custom World's deliveries never install eve's generation context,
    // so the durable payload must be resolvable without it.
    const source = resolveNitroCompiledArtifactsSource(config);
    const durable = serializeDurableCompiledArtifactsSource(source);
    expect(durable).toBe(source);
  });
});
