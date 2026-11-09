import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "vitest";
import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const createTemporaryDirectory = useTemporaryDirectories();
const runFile = promisify(execFile);
const root = fileURLToPath(new URL("../../../..", import.meta.url));

describe("packed client declarations", () => {
  it("checks client inspection types without workspace dependency resolution", async () => {
    const app = await createTemporaryDirectory("eve-packed-client-types-");
    const tarball = process.env.EVE_SCENARIO_EVE_TARBALL_PATH;
    if (tarball === undefined) throw new Error("Scenario setup did not pack eve.");
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { eve: `file:${tarball}` },
      }),
    );
    await writeFile(join(app, "pnpm-workspace.yaml"), "autoInstallPeers: false\n");
    await runPnpmCommand({
      args: ["install", "--ignore-scripts", "--config.minimum-release-age=0"],
      cwd: app,
    });
    // Deliberately no AI SDK, Zod, or workspace links: these two data contracts
    // must stand alone even when other eve entries need integration peers.
    await writeFile(
      join(app, "consumer.ts"),
      `
import type { AgentInfoResult } from "./node_modules/eve/dist/src/client/agent-info-types.js";
import type { HealthResult } from "./node_modules/eve/dist/src/client/health-types.js";
type IsAny<T> = 0 extends 1 & T ? true : false;
type Assert<T extends false> = T;
type InfoIsTyped = Assert<IsAny<AgentInfoResult>>;
type HealthIsTyped = Assert<IsAny<HealthResult>>;
declare const info: AgentInfoResult;
const name: string = info.agent.name;
const health: HealthResult = { ok: true, status: "ready", workflowId: "workflow" };
// @ts-expect-error Inspection version is fixed by the wire contract.
const wrongVersion: AgentInfoResult["version"] = 4;
// @ts-expect-error The response is read-only.
info.agent.name = "changed";
void [name, health, wrongVersion];
`,
    );
    await writeFile(
      join(app, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types: [],
          target: "ES2024",
          module: "NodeNext",
        },
        include: ["consumer.ts"],
      }),
    );
    try {
      await runFile(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", app]);
    } catch (error) {
      throw new Error((error as { stdout?: string }).stdout ?? String(error), { cause: error });
    }
    const require = createRequire(import.meta.url);
    const aiVersion = (require("ai/package.json") as { version: string }).version;
    await runPnpmCommand({
      args: [
        "add",
        `ai@${aiVersion}`,
        "@types/json-schema@^7",
        "zod@^4.1.8",
        "@types/node@^24",
        "--ignore-scripts",
        "--config.minimum-release-age=0",
      ],
      cwd: app,
    });
    const source = await readFile(join(app, "consumer.ts"), "utf8");
    await writeFile(
      join(app, "consumer.ts"),
      source
        .replaceAll("./node_modules/eve/dist/src/client/agent-info-types.js", "eve/client")
        .replaceAll("./node_modules/eve/dist/src/client/health-types.js", "eve/client"),
    );
    await writeFile(
      join(app, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types: ["node"],
          target: "ES2024",
          module: "NodeNext",
        },
        include: ["consumer.ts"],
      }),
    );
    try {
      await runFile(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", app]);
    } catch (error) {
      throw new Error((error as { stdout?: string }).stdout ?? String(error), { cause: error });
    }
  }, 60_000);
});
