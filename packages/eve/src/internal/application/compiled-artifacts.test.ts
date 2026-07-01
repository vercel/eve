import { describe, expect, it } from "vitest";

import { COMPILE_METADATA_KIND, COMPILE_METADATA_VERSION } from "#compiler/artifacts.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { createCompiledAgentManifest } from "#compiler/manifest.js";
import { createCompiledArtifactsBootstrapSource } from "#internal/application/compiled-artifacts.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";

describe("createCompiledArtifactsBootstrapSource", () => {
  it("generates static Workflow world bootstrap imports from compiled config", async () => {
    const source = await createCompiledArtifactsBootstrapSource({
      compileResult: {
        manifest: createCompiledAgentManifest({
          agentRoot: "/app/agent",
          appRoot: "/app",
          config: {
            model: {
              id: "openai/gpt-5.5",
              routing: classifyModelRouting("openai/gpt-5.5"),
            },
            name: "app",
            experimental: {
              workflow: {
                world: "@acme/eve-world",
              },
            },
          },
        }),
        metadata: {
          compile: { moduleMap: { path: "module-map.mjs", sha256: "0" } },
          discovery: {
            diagnostics: { path: "diagnostics.json", sha256: "0" },
            manifest: { path: "manifest.json", sha256: "0" },
            sourceGraphHash: "0",
            summary: { errors: 0, warnings: 0 },
          },
          generator: { name: "eve", version: "0.0.0-test" },
          kind: COMPILE_METADATA_KIND,
          status: "ready",
          version: COMPILE_METADATA_VERSION,
        },
      } as CompileAgentResult,
      installModulePath: "/eve/src/runtime/loaders/bundled-artifacts.ts",
      metadata: {
        compile: { moduleMap: { path: "module-map.mjs", sha256: "0" } },
        discovery: {
          diagnostics: { path: "diagnostics.json", sha256: "0" },
          manifest: { path: "manifest.json", sha256: "0" },
          sourceGraphHash: "0",
          summary: { errors: 0, warnings: 0 },
        },
        generator: { name: "eve", version: "0.0.0-test" },
        kind: COMPILE_METADATA_KIND,
        status: "ready",
        version: COMPILE_METADATA_VERSION,
      },
      moduleMapPath: "/app/.eve/compile/compiled-artifacts-bootstrap.mjs",
    });

    expect(source).toContain('import * as workflowWorldModule from "@acme/eve-world";');
    expect(source).toContain('installEveWorkflowQueueNamespace("app");');
    expect(source).toContain(
      'await installConfiguredWorkflowWorld({ module: workflowWorldModule, packageName: "@acme/eve-world" });',
    );
  });
});
