import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAuthoredModuleGraph } from "#internal/authored-module-graph.js";
import { AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH } from "#internal/authored-module-loader.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";

const TOOL_COUNT = 300;
const EVALUATIONS = "__eveAuthoredModuleGraphEvaluations";

function toolSource(index: number): string {
  return [
    'import { label } from "../lib/label.ts";',
    `globalThis.${EVALUATIONS} = [...(globalThis.${EVALUATIONS} ?? []), ${index}];`,
    `export default { description: label + " ${index}", execute: () => ${index} };`,
    "",
  ].join("\n");
}

describe("createAuthoredModuleGraph", () => {
  const createAppRoot = useTemporaryAppRoots();

  afterEach(() => {
    Reflect.deleteProperty(globalThis, EVALUATIONS);
  });

  it("bundles a large graph into one file and evaluates each module only when loaded", async () => {
    const files: Record<string, string> = {
      "agent/lib/label.ts": 'export const label = "Tool";\n',
      "agent/broken.ts": 'throw new Error("broken at load");\nexport default {};\n',
    };
    for (let index = 0; index < TOOL_COUNT; index += 1) {
      files[`agent/tools/tool_${index}.ts`] = toolSource(index);
    }
    const app = await createAppRoot("eve-authored-module-graph-", { files });
    const toolPaths = Array.from({ length: TOOL_COUNT }, (_, index) =>
      join(app.agentRoot, "tools", `tool_${index}.ts`),
    );
    const brokenPath = join(app.agentRoot, "broken.ts");
    const graph = createAuthoredModuleGraph([...toolPaths, brokenPath], { appRoot: app.appRoot });

    const first = await graph.loader(toolPaths[7]!, []);
    expect(await first!()).toMatchObject({ default: { description: "Tool 7" } });
    expect(Reflect.get(globalThis, EVALUATIONS)).toEqual([7]);

    const loaded = await Promise.all(
      toolPaths.map(async (path) => (await (await graph.loader(path, []))!()) as object),
    );
    expect(loaded.map((namespace) => Reflect.get(namespace, "default").execute())).toEqual(
      toolPaths.map((_, index) => index),
    );
    expect(Reflect.get(globalThis, EVALUATIONS)).toHaveLength(TOOL_COUNT);

    const broken = await graph.loader(brokenPath, []);
    await expect(broken!()).rejects.toThrow("broken at load");

    const bundles = await readdir(join(app.appRoot, AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH));
    expect(bundles.filter((name) => name.endsWith(".mjs"))).toHaveLength(1);
  });
});
