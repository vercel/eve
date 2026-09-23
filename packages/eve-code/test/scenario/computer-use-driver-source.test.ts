import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { COMPUTER_USE_DRIVER_SOURCES } from "../../extension/lib/computer-use-driver-source.ts";
import { installComputerUse } from "../../extension/lib/computer-use-sandbox.ts";

const execFileAsync = promisify(execFile);

test("each embedded driver source parses with node", async () => {
  const directory = await mkdtemp(join(tmpdir(), "computer-use-driver-"));
  try {
    for (const [name, source] of Object.entries(COMPUTER_USE_DRIVER_SOURCES)) {
      if (!name.endsWith(".mjs")) continue;
      const path = join(directory, name);
      await writeFile(path, source);
      await execFileAsync(process.execPath, ["--check", path]);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("grounding state keeps only visible labeled elements with a hard cap", async () => {
  const source = COMPUTER_USE_DRIVER_SOURCES["state.mjs"];
  const module = (await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  )) as {
    selectGroundingElements(elements: unknown[]): Array<{ element_index: number }>;
  };
  const visible = Array.from({ length: 82 }, (_, element_index) => ({
    element_index,
    frame: { h: 20, w: 100, x: 20, y: 200 + element_index },
    label: `target ${element_index}`,
    role: "button",
  }));
  const selected = module.selectGroundingElements([
    ...visible,
    { element_index: 82, frame: { h: 20, w: 100, x: 20, y: 300 }, label: "" },
    { element_index: 83, frame: { h: 20, w: 100, x: 20, y: 1_200 }, label: "hidden" },
  ]);
  assert.equal(selected.length, 80);
  assert.deepEqual(
    selected.map(({ element_index }) => element_index),
    Array.from({ length: 80 }, (_, index) => index),
  );
});

test("computer-use bootstrap writes all assets and installs pinned dependencies with npm", async () => {
  const files = new Map<string, string>();
  const commands: string[] = [];
  await installComputerUse({
    resolvePath: (path) => `/custom/workspace/${path}`,
    run: async ({ command }) => {
      commands.push(command);
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    writeTextFile: async ({ path, content }) => {
      files.set(path, content);
    },
  });
  for (const name of Object.keys(COMPUTER_USE_DRIVER_SOURCES)) {
    assert.ok(files.has(`/custom/workspace/.eve-code/computer-use-driver/${name}`));
  }
  const driverPackage = JSON.parse(COMPUTER_USE_DRIVER_SOURCES["package.json"]);
  assert.deepEqual(driverPackage.dependencies, { "@trycua/cua-driver": "0.12.5" });
  assert.equal(driverPackage.packageManager, undefined);
  const installScript = files.get("/custom/workspace/.eve-code/install-computer-use.sh") ?? "";
  assert.match(installScript, /computer-use requires an apt-based sandbox image/u);
  assert.match(installScript, /firefox-esr/u);
  assert.match(installScript, /\bffmpeg\b/u);
  assert.match(installScript, /\bxterm\b/u);
  assert.match(
    installScript,
    /npm install --prefix '\/custom\/workspace\/.eve-code\/computer-use-driver' --ignore-scripts --no-audit --no-fund/u,
  );
  assert.doesNotMatch(installScript, /\bgh\b/u);
  assert.match(commands.at(-1) ?? "", /sudo -n bash/u);
});
