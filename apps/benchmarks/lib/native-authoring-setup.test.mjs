import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createJiti } from "jiti";

import { fixtureNames } from "./experiment-files.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { JUST_BASH_VERSION, VITEST_VERSION, createNativeAuthoringSetup, setupsFor } =
  await jiti.import(new URL("./native-authoring-setup.ts", import.meta.url).pathname);
const { loadAuthoringCase } = await jiti.import(
  new URL("./load-authoring-case.ts", import.meta.url).pathname,
);

test("installs the just-bash and vitest versions eve tests against", () => {
  const eve = JSON.parse(
    readFileSync(new URL("../../../packages/eve/package.json", import.meta.url)),
  );
  assert.equal(JUST_BASH_VERSION, eve.devDependencies["just-bash"]);
  const catalog = readFileSync(new URL("../../../pnpm-workspace.yaml", import.meta.url), "utf8");
  assert.ok(catalog.includes(`\n  vitest: "${VITEST_VERSION}"\n`));
});

test("bootstraps the selected source before a native agent starts", async () => {
  const commands = [];
  const writes = [];
  const setup = createNativeAuthoringSetup({
    packageSpec: "https://pkg.eve.dev/commit/eve.tgz",
    revision: "commit",
    treatment: "baseline",
  });
  await setup({
    async readFile(path) {
      assert.equal(path, ".eve-authoring-bootstrap.json");
      return JSON.stringify({
        startingPoint: "scaffolded",
        revision: "commit",
        setupIds: ["inventory-openapi-v1"],
      });
    },
    async writeFiles(files) {
      writes.push(files);
    },
    async runCommand(command, args, options) {
      commands.push({ command, args, options });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    getWorkingDirectory: () => "/workspace",
    setWorkingDirectory() {},
  });

  assert.match(commands[0].args[1], /rm -f \.eve-authoring-bootstrap\.json/u);
  assert.deepEqual(Object.keys(writes[0]), ["/usr/local/bin/eve"]);
  assert.match(writes[0]["/usr/local/bin/eve"], /pkg\.eve\.dev\/commit\/eve\.tgz/u);
  assert.match(commands[1].args[1], /chmod \+x \/usr\/local\/bin\/eve/u);
  assert.match(
    commands[2].args[1],
    /AI_AGENT=claude EVE_INIT_PACKAGE_SPEC=.* eve init \. --model openai\/gpt-5\.5/u,
  );
  assert.match(
    commands[3].args[1],
    /npm install --save-dev --save-exact just-bash@3\.6\.0 vitest@5\.0\.2/u,
  );
  assert.match(commands[4].args[1], /mkdir -p agent\/lib/u);
  assert.match(commands[5].args[1], /rm -f AGENTS\.md CLAUDE\.md GEMINI\.md/u);
  assert.match(commands[6].args[1], /npm run typecheck && npm run build/u);
  assert.match(commands[7].args[1], /git add \. && git commit --amend --no-edit --quiet/u);
  assert.deepEqual(Object.keys(writes[1]), ["/workspace/agent/lib/inventory-openapi.ts"]);
  assert.match(writes[1]["/workspace/agent/lib/inventory-openapi.ts"], /getStock/u);
});

test("registers the setup of every case the native runner can run", async () => {
  const evalsRoot = new URL("../evals", import.meta.url).pathname;
  for (const name of fixtureNames(evalsRoot)) {
    const authoringCase = await loadAuthoringCase(`${evalsRoot}/${name}`);
    let prompts = 0;
    await authoringCase.interact({
      send: async () => {
        prompts += 1;
        return { text: "", toolCalls: [] };
      },
    });
    // Multi-turn cases are rejected before their setups matter.
    if (prompts !== 1) continue;
    const ids = [authoringCase.startingPoint.setup, authoringCase.setup]
      .filter(Boolean)
      .map((setup) => setup.id);
    assert.doesNotThrow(() => setupsFor(ids), name);
  }
});

test("fails a case whose setup the native runner does not know before bootstrapping", async () => {
  const commands = [];
  const setup = createNativeAuthoringSetup({
    packageSpec: "https://pkg.eve.dev/commit/eve.tgz",
    revision: "commit",
    treatment: "guided",
  });
  await assert.rejects(
    setup({
      async readFile() {
        return JSON.stringify({
          startingPoint: "scaffolded",
          revision: "commit",
          setupIds: ["unregistered-v1"],
        });
      },
      async writeFiles() {},
      async runCommand(command, args) {
        commands.push(args);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      getWorkingDirectory: () => "/workspace",
    }),
    /Setup "unregistered-v1" is not registered with the native runner/u,
  );
  assert.deepEqual(commands, []);
});

test("rejects a broken starting workspace before handing it to the model", async () => {
  const setup = createNativeAuthoringSetup({
    packageSpec: "https://pkg.eve.dev/commit/eve.tgz",
    revision: "commit",
    treatment: "guided",
  });
  await assert.rejects(
    setup({
      async readFile() {
        return JSON.stringify({ startingPoint: "scaffolded", revision: "commit", setupIds: [] });
      },
      async writeFiles() {},
      async runCommand(_command, args) {
        const failed = args[1].includes("npm run typecheck && npm run build");
        return {
          stdout: "",
          stderr: failed ? "missing optional package" : "",
          exitCode: failed ? 1 : 0,
        };
      },
      getWorkingDirectory: () => "/workspace",
    }),
    /starting workspace validation failed.*missing optional package/su,
  );
});
