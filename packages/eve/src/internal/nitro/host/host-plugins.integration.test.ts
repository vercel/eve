import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePackageRoot, resolveWorkflowModulePath } from "#internal/application/package.js";
import type { ExternalsPolicy } from "#internal/nitro/host/externals-policy.js";
import { createHostPlugins, type HostPluginsInput } from "#internal/nitro/host/host-plugins.js";
import { createInstrumentationEntry } from "#internal/nitro/host/instrumentation-entry.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createTemporaryDirectory = useTemporaryDirectories();

const APP_ROOT = "/tmp/weather-agent";
const WORKFLOW_DIR = `${APP_ROOT}/.eve/workflow`;
const STEP_SOURCE = 'export async function add(a, b) { "use step"; return a + b; }\n';

const NO_EXTERNALS: ExternalsPolicy = {
  checkedExternals: [],
  extensionTracePaths: {},
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
    workflowBuildDir: WORKFLOW_DIR,
    ...overrides,
  });
  if (!Array.isArray(list)) throw new Error("Expected a plugin list.");
  return list.filter(
    (plugin): plugin is Plugin => typeof plugin === "object" && plugin !== null && "name" in plugin,
  );
}

function matchesFilter(filter: unknown, id: string): boolean {
  if (filter === undefined) return true;
  if (filter instanceof RegExp) return filter.test(id);
  if (Array.isArray(filter)) return filter.some((pattern) => matchesFilter(pattern, id));
  const { exclude, include } = filter as { exclude?: unknown; include?: unknown };
  return (
    (exclude === undefined || !matchesFilter(exclude, id)) &&
    (include === undefined || matchesFilter(include, id))
  );
}

/** Calls one hook the way Rolldown does: object hooks run only when their id filter matches. */
async function callHook(plugin: Plugin, hook: HookName, ...args: unknown[]): Promise<unknown> {
  const value = plugin[hook] as
    | ((...hookArgs: unknown[]) => unknown)
    | { filter?: { id?: unknown }; handler: (...hookArgs: unknown[]) => unknown }
    | undefined;
  if (value === undefined) return null;
  const { filter, handler } =
    typeof value === "function" ? { filter: undefined, handler: value } : value;
  const id = String(hook === "transform" ? args[1] : args[0]);
  if (!matchesFilter(filter?.id, id)) return null;
  return (await handler.call({}, ...args)) ?? null;
}

/** The first non-null result across the list, as the bundler resolves, loads, or transforms. */
async function firstResult(list: Plugin[], hook: HookName, ...args: unknown[]) {
  for (const plugin of list) {
    const result = await callHook(plugin, hook, ...args);
    if (result !== null) return result;
  }
  return null;
}

describe("createHostPlugins", () => {
  it("orders step and side-effect handling first, then the hosted graph, then extensions", async () => {
    const sourceRoot = await realpath(await createTemporaryDirectory("eve-host-plugins-mount-"));
    await mkdir(join(sourceRoot, "node_modules", "zod"), { recursive: true });
    await writeFile(
      join(sourceRoot, "node_modules", "zod", "package.json"),
      JSON.stringify({ name: "zod", main: "index.js" }),
    );
    await writeFile(join(sourceRoot, "node_modules", "zod", "index.js"), "");
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
          externalDependencies: ["zod"],
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
    }).map((plugin) => plugin.name);

    expect(names).toEqual([
      "eve:workflow-step-transform",
      "eve:workflow-step-module-side-effects",
      "eve:instrumentation-module-side-effects",
      "eve:workflow-module-side-effects",
      "eve:nitro-routing-import-specifiers",
      "eve:instrumentation-entry",
      "eve-node-esm-compat-banner",
      "eve-pseudo-packages",
      "eve-hosted-development-runtime-prune",
      "eve-hosted-sandbox-provider-prune",
      "eve-optional-engine-dependency-external",
      "eve-extension-external-dependency",
      "eve-external-dependency-output-check",
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

  it("rewrites Windows drive paths only in Nitro's generated routing modules", async () => {
    const list = plugins();
    const source = 'import handler from "G:\\projects\\app\\dist\\route.js";';

    expect(await firstResult(list, "transform", source, "#nitro/virtual/routing")).toEqual({
      code: 'import handler from "file:///G:/projects/app/dist/route.js";',
      map: null,
    });
    expect(await firstResult(list, "transform", source, "/tmp/other.js")).toBeNull();
  });
});
