import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePackageRoot, resolveWorkflowModulePath } from "#internal/application/package.js";
import type { ExternalsPolicy } from "#internal/nitro/host/externals-policy.js";
import { createHostPlugins, type HostPluginsInput } from "#internal/nitro/host/host-plugins.js";
import { createInstrumentationEntry } from "#internal/nitro/host/instrumentation-entry.js";
import { bundleThroughPlugins } from "#internal/testing/rolldown-plugin-harness.js";

const APP_ROOT = "/tmp/weather-agent";
const WORKFLOW_DIR = `${APP_ROOT}/.eve/workflow`;
const STEP_SOURCE = 'export async function add(a, b) { "use step"; return a + b; }\n';

const NO_EXTERNALS: ExternalsPolicy = {
  checkedExternals: [],
  pruneDevelopmentRuntime: false,
  pruneSandboxProviders: false,
  traceDeps: [],
  untracedExternals: [],
};

type Plugin = Record<string, unknown> & { readonly name: string };

function plugins(overrides: Partial<HostPluginsInput> = {}): Plugin[] {
  const list = createHostPlugins({
    appRoot: APP_ROOT,
    authoredPackageRoot: APP_ROOT,
    externals: NO_EXTERNALS,
    extensionMounts: [],
    extensionOverridePaths: new Map(),
    workflowArtifacts: {
      stepTargets: [],
      stepsPath: `${WORKFLOW_DIR}/steps.mjs`,
      workflowsPath: `${WORKFLOW_DIR}/workflows.mjs`,
    },
    ...overrides,
  });
  if (!Array.isArray(list)) throw new Error("Expected a plugin list.");
  return list.filter(
    (plugin): plugin is Plugin => typeof plugin === "object" && plugin !== null && "name" in plugin,
  );
}

/** Asserts each `[before, after]` plugin pair keeps its relative order. */
function expectOrder(names: readonly string[], pairs: readonly (readonly [string, string])[]) {
  for (const [before, after] of pairs) {
    expect(names.indexOf(before), `${before} in ${names.join(", ")}`).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(before), `${before} before ${after}`).toBeLessThan(names.indexOf(after));
  }
}

describe("createHostPlugins", () => {
  it("orders step transforms and side-effect resolution first, then the hosted graph, then extensions", async () => {
    const sourceRoot = `${APP_ROOT}/node_modules/layout-extension/dist/extension`;
    const names = plugins({
      externals: {
        ...NO_EXTERNALS,
        checkedExternals: ["sharp"],
        pruneDevelopmentRuntime: true,
        pruneSandboxProviders: true,
        untracedExternals: ["just-bash"],
      },
      extensionMounts: [
        {
          externalDependencies: [],
          mountId: "extensions/layout",
          mountLogicalPath: "extensions/layout.ts",
          mountSourceId: "extensions/layout.ts",
          mountSourcePath: join(sourceRoot, "layout.ts"),
          namespace: "layout",
          packageName: "layout-extension",
          sourceRoot,
          specifier: "layout-extension",
        },
      ],
      instrumentationEntryPlugin: createInstrumentationEntry(`${APP_ROOT}/.eve/instrumentation.mjs`)
        .plugin,
      instrumentationSourcePaths: [`${APP_ROOT}/agent/instrumentation/audit.ts`],
      workflowArtifacts: {
        stepTargets: [`${APP_ROOT}/agent/steps/add.ts`],
        stepsPath: `${WORKFLOW_DIR}/steps.mjs`,
        workflowsPath: `${WORKFLOW_DIR}/workflows.mjs`,
      },
    }).map((plugin) => plugin.name);

    expectOrder(names, [
      ["eve:workflow-step-transform", "eve:side-effect-modules"],
      ["eve:side-effect-modules", "eve:hosted-graph"],
      ["eve:hosted-graph", "eve-extension-mount"],
    ]);
    expect(names).toContain("eve:instrumentation-entry");
  });

  it("transforms step targets in step mode, giving eve's dist sources their src step ids", async () => {
    const packageRoot = resolvePackageRoot();
    const sourceStep = join(packageRoot, "src", "execution", "fixture-step.ts");
    const distStep = join(packageRoot, "dist", "src", "execution", "fixture-step.js");
    const authoredStep = `${APP_ROOT}/agent/steps/add.ts`;
    const list = plugins({
      workflowArtifacts: {
        stepTargets: [sourceStep, distStep, authoredStep],
        stepsPath: `${WORKFLOW_DIR}/steps.mjs`,
        workflowsPath: `${WORKFLOW_DIR}/workflows.mjs`,
      },
    });
    const bundle = async (id: string) =>
      await bundleThroughPlugins({ files: { [id]: STEP_SOURCE }, plugins: list, reexports: [id] });

    expect(await bundle(authoredStep)).toContain(
      'registerStepFunction("step//./agent/steps/add//add", add)',
    );
    expect(await bundle(distStep)).toContain(
      'registerStepFunction("step//./src/execution/fixture-step//add", add)',
    );
    expect(await bundle(sourceStep)).toContain(
      'registerStepFunction("step//./src/execution/fixture-step//add", add)',
    );
    expect(await bundle(`${APP_ROOT}/agent/steps/other.ts`)).not.toContain("registerStepFunction");
  });

  it("keeps the workflow bundle, step targets, and instrumentation modules side-effectful", async () => {
    const stepTarget = `${WORKFLOW_DIR}/imports/step-module.js`;
    const instrumentation = `${APP_ROOT}/agent/instrumentation/audit.ts`;
    const list = plugins({
      instrumentationSourcePaths: [instrumentation],
      workflowArtifacts: {
        stepTargets: [stepTarget, resolveWorkflowModulePath("workflow/internal/builtins")],
        stepsPath: `${WORKFLOW_DIR}/steps.mjs`,
        workflowsPath: `${WORKFLOW_DIR}/workflows.mjs`,
      },
    });
    const builtins = resolveWorkflowModulePath("workflow/internal/builtins");
    const marker = (name: string) => `globalThis.marker = ${JSON.stringify(`${name} kept`)};\n`;
    // Unclaimed modules are side-effect free, so the bundle drops every module
    // the plugin does not keep.
    const code = await bundleThroughPlugins({
      files: {
        [`${WORKFLOW_DIR}/steps.mjs`]: [
          'import "./imports/step-module.js";',
          'import "workflow/internal/builtins";',
          marker("steps"),
        ].join("\n"),
        [`${WORKFLOW_DIR}/workflows-handler.mjs`]: 'import "./workflows.mjs";\n',
        [`${WORKFLOW_DIR}/workflows.mjs`]: marker("workflows"),
        [stepTarget]: marker("step target"),
        [builtins]: marker("builtins"),
        [instrumentation]: marker("instrumentation"),
        "/tmp/other-module.mjs": marker("other"),
      },
      imports: [
        `${WORKFLOW_DIR}/steps.mjs`,
        `${WORKFLOW_DIR}/workflows-handler.mjs`,
        instrumentation,
        "/tmp/other-module.mjs",
      ],
      plugins: list,
      sideEffectFree: true,
    });

    for (const name of ["steps", "workflows", "step target", "builtins", "instrumentation"]) {
      expect(code).toContain(`${name} kept`);
    }
    expect(code).not.toContain("other kept");
  });
});
