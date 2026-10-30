import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePackageRoot, resolveWorkflowModulePath } from "#internal/application/package.js";
import type { ExternalsPolicy } from "#internal/nitro/host/externals-policy.js";
import { createHostPlugins, type HostPluginsInput } from "#internal/nitro/host/host-plugins.js";
import { createInstrumentationEntry } from "#internal/nitro/host/instrumentation-entry.js";
import { callPluginHook } from "#internal/testing/plugin-hooks.js";

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
type HookName = "load" | "resolveId" | "transform";

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

/** The first non-null result across the list, as the bundler resolves, loads, or transforms. */
async function firstResult(list: Plugin[], hook: HookName, ...args: unknown[]) {
  for (const plugin of list) {
    const result = await callPluginHook(plugin, hook, ...args);
    if (result !== null) return result;
  }
  return null;
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

    expect(names).toEqual([
      "eve:workflow-step-transform",
      "eve:side-effect-modules",
      "eve:nitro-routing-import-specifiers",
      "eve:instrumentation-entry",
      "eve-node-esm-compat-banner",
      "eve-pseudo-packages",
      "eve:hosted-graph",
      "eve-extension-mount",
      "eve-extension-scope",
      "eve-authored-asset-import",
    ]);
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
    const transform = async (id: string) =>
      ((await firstResult(list, "transform", STEP_SOURCE, id)) as { code: string } | null)?.code;

    expect(await transform(authoredStep)).toContain(
      'registerStepFunction("step//./agent/steps/add//add", add)',
    );
    expect(await transform(distStep)).toContain(
      'registerStepFunction("step//./src/execution/fixture-step//add", add)',
    );
    expect(await transform(sourceStep)).toContain(
      'registerStepFunction("step//./src/execution/fixture-step//add", add)',
    );
    expect(await transform(`${APP_ROOT}/agent/steps/other.ts`)).toBeUndefined();
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
    const kept = (id: string) => ({ id, moduleSideEffects: "no-treeshake" });

    expect(await firstResult(list, "resolveId", `${WORKFLOW_DIR}/steps.mjs`)).toEqual(
      kept(`${WORKFLOW_DIR}/steps.mjs`),
    );
    expect(
      await firstResult(
        list,
        "resolveId",
        "./workflows.mjs",
        `${WORKFLOW_DIR}/workflows-handler.mjs`,
      ),
    ).toEqual(kept(`${WORKFLOW_DIR}/workflows.mjs`));
    expect(
      await firstResult(list, "resolveId", "./imports/step-module.js", `${WORKFLOW_DIR}/steps.mjs`),
    ).toEqual(kept(stepTarget));
    expect(
      await firstResult(
        list,
        "resolveId",
        "workflow/internal/builtins",
        `${WORKFLOW_DIR}/steps.mjs`,
      ),
    ).toEqual(kept(resolveWorkflowModulePath("workflow/internal/builtins")));
    expect(await firstResult(list, "resolveId", instrumentation)).toEqual(kept(instrumentation));
    expect(await firstResult(list, "resolveId", "/tmp/other-module.mjs")).toBeNull();
  });
});
