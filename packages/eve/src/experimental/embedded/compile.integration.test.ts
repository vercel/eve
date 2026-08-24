import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { compiledAgentManifestSchema } from "#compiler/manifest.js";
import { compiledModuleMapSchema } from "#compiler/module-map.js";
import { compileEmbeddedAgent } from "./compile.js";
import { loadEmbeddedAgentEntrypoint } from "./definition.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("embedded agent compilation", () => {
  it("loads a strict branded default export and emits production artifacts", async () => {
    const appRoot = await createApp();
    const result = await compileEmbeddedAgent({ appRoot, entrypoint: "embedded-agent.mjs" });

    expect(compiledAgentManifestSchema.parse(result.manifest)).toMatchObject({
      agentRoot: result.project.agentRoot,
      appRoot: result.project.appRoot,
      config: {
        model: { id: "openai/gpt-5.4-mini" },
        source: {
          logicalPath: "embedded-agent.mjs",
          sourceId: "embedded:config:embedded-agent.mjs",
        },
      },
      instructions: [
        {
          content: "Classify the ticket.",
          logicalPath: "instructions.md",
          role: "system",
          sourceKind: "markdown",
        },
      ],
    });
    expect(result.metadata.status).toBe("ready");
    expect(result.diagnostics).toEqual([]);

    const moduleMapSource = await readFile(result.paths.moduleMapPath, "utf8");
    expect(moduleMapSource).toContain('from "../../embedded-agent.mjs"');
    const imported = await import(
      `${pathToFileURL(result.paths.moduleMapPath).href}?test=${Date.now()}`
    );
    const moduleMap = compiledModuleMapSchema.parse(imported.default);
    expect(
      moduleMap.nodes.__root__?.modules["embedded:config:embedded-agent.mjs"]?.default,
    ).toMatchObject({ model: "openai/gpt-5.4-mini" });
    expect(
      result.moduleMap.nodes.__root__?.modules["embedded:config:embedded-agent.mjs"],
    ).toBeDefined();
  });

  it("rejects missing, unbranded, malformed, and escaping entrypoints", async () => {
    const appRoot = await createApp();
    await writeFile(join(appRoot, "missing-default.mjs"), "export const value = 1;\n");
    await writeFile(
      join(appRoot, "unbranded.mjs"),
      "export default { model: 'openai/gpt-5.4-mini' };\n",
    );
    await writeFile(
      join(appRoot, "malformed.mjs"),
      brandedModuleSource("Classify.", "{ model: 'openai/gpt-5.4-mini', unknown: true }"),
    );

    await expect(
      loadEmbeddedAgentEntrypoint({ appRoot, entrypoint: "missing-default.mjs" }),
    ).rejects.toThrow('entrypoint "missing-default.mjs"');
    await expect(
      loadEmbeddedAgentEntrypoint({ appRoot, entrypoint: "unbranded.mjs" }),
    ).rejects.toThrow("defineEmbeddedAgent");
    await expect(
      loadEmbeddedAgentEntrypoint({ appRoot, entrypoint: "malformed.mjs" }),
    ).rejects.toThrow("malformed");
    await expect(
      loadEmbeddedAgentEntrypoint({ appRoot, entrypoint: "../outside.mjs" }),
    ).rejects.toThrow("under the application root");
  });
});

async function createApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-embedded-test-"));
  temporaryDirectories.push(appRoot);
  await writeFile(
    join(appRoot, "package.json"),
    JSON.stringify({ name: "embedded-test", type: "module" }),
  );
  await writeFile(
    join(appRoot, "embedded-agent.mjs"),
    brandedModuleSource("Classify the ticket.", "{ model: 'openai/gpt-5.4-mini' }"),
  );
  return appRoot;
}

function brandedModuleSource(instructions: string, definitionSource: string): string {
  return `const definition = ${definitionSource};
Object.defineProperties(definition, {
  [Symbol.for("eve.experimental.embedded-agent")]: { value: true },
  [Symbol.for("eve.experimental.embedded-agent.instructions")]: { value: ${JSON.stringify(instructions)} },
});
export default definition;
`;
}
