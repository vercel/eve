import assert from "node:assert/strict";
import { test } from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createNativeAuthoringSetup } = await jiti.import(
  new URL("./native-authoring-setup.ts", import.meta.url).pathname,
);

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
  assert.match(commands[3].args[1], /mkdir -p agent\/lib/u);
  assert.match(commands[4].args[1], /rm -f AGENTS\.md CLAUDE\.md GEMINI\.md/u);
  assert.match(commands[5].args[1], /git add \. && git commit --amend --no-edit --quiet/u);
  assert.deepEqual(Object.keys(writes[1]), ["/workspace/agent/lib/inventory-openapi.ts"]);
  assert.match(writes[1]["/workspace/agent/lib/inventory-openapi.ts"], /getStock/u);
});
