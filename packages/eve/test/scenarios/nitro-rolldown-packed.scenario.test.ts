import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";

const runFile = promisify(execFile);
const scenarioApp = useScenarioApp();

const PACKED_CONSUMER_PROBE = `
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const consumerRequire = createRequire(import.meta.url);
const consumerManifest = consumerRequire("./package.json");
const eveManifestPath = consumerRequire.resolve("eve/package.json");
const eveManifest = consumerRequire(eveManifestPath);
const eveRequire = createRequire(eveManifestPath);
const nitroManifest = eveRequire("nitro/package.json");
const wrapperPath = join(
  dirname(eveManifestPath),
  "dist/src/internal/bundler/nitro-rolldown.js",
);
const { buildWithNitroRolldown, parseWithNitroRolldownAst } = await import(
  pathToFileURL(wrapperPath).href
);

const ast = await parseWithNitroRolldownAst(
  "entry.ts",
  "export const parsedAnswer: number = 42;",
);
const build = await buildWithNitroRolldown({
  input: "virtual:entry.js",
  output: { format: "esm" },
  plugins: [
    {
      name: "packed-consumer-entry",
      resolveId(id) {
        return id === "virtual:entry.js" ? id : null;
      },
      load(id) {
        return id === "virtual:entry.js" ? "export const bundledAnswer = 42;" : null;
      },
    },
  ],
  write: false,
});
const chunk = build.output.find((entry) => entry.type === "chunk");

console.log(
  JSON.stringify({
    bundled: chunk?.code.includes("bundledAnswer") === true,
    consumerDeclaresRolldown: typeof consumerManifest.dependencies?.rolldown === "string",
    eveDeclaresRolldown: typeof eveManifest.dependencies?.rolldown === "string",
    nitroDeclaresRolldown: typeof nitroManifest.dependencies?.rolldown === "string",
    parsed:
      ast?.type === "Program" &&
      Array.isArray(ast.body) &&
      ast.body[0]?.type === "ExportNamedDeclaration",
  }),
);
`;

describe("packed Nitro Rolldown wrapper", () => {
  it.each(["npm", "pnpm"] as const)(
    "builds and parses from Nitro's dependency tree in a %s consumer",
    async (packageManager) => {
      const app = await scenarioApp({
        files: {
          "probe.mjs": PACKED_CONSUMER_PROBE,
        },
        installDependencies: true,
        name: "packed-nitro-rolldown",
        packageManager,
      });

      const { stdout } = await runFile(process.execPath, ["probe.mjs"], {
        cwd: app.appRoot,
        maxBuffer: 10 * 1024 * 1024,
      });

      expect(JSON.parse(stdout.trim())).toEqual({
        bundled: true,
        consumerDeclaresRolldown: false,
        eveDeclaresRolldown: false,
        nitroDeclaresRolldown: true,
        parsed: true,
      });
    },
    120_000,
  );
});
