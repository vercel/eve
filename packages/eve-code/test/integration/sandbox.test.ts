import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxSession } from "eve/sandbox";
import { CODE_TOOLING_REVALIDATION_KEY, installCodeTooling } from "../../extension/lib/sandbox.ts";

test("installs trusted GitHub executables outside the writable workspace", async () => {
  const commands: string[] = [];
  const writes: string[] = [];
  const sandbox: Pick<SandboxSession, "resolvePath" | "run" | "writeTextFile"> = {
    resolvePath(path: string) {
      return `/workspace/${path}`.replace(/\/$/u, "");
    },
    async run({ command }: { command: string }) {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeTextFile({ path }: { path: string }) {
      writes.push(path);
    },
  };

  await installCodeTooling(sandbox as SandboxSession);

  assert.match(CODE_TOOLING_REVALIDATION_KEY, /eve-code-tooling:2:/u);
  assert.ok(writes.every((path) => path.startsWith("/workspace/.eve-code/")));
  assert.match(
    commands[0] ?? "",
    /\$INSTALL -m 755 \/usr\/bin\/gh '\/usr\/local\/lib\/eve-code\/gh'/u,
  );
  assert.match(
    commands[0] ?? "",
    /\$INSTALL -m 755 '\/workspace\/\.eve-code\/gh-signed-commit' '\/usr\/local\/lib\/eve-code\/gh-signed-commit'/u,
  );
  assert.doesNotMatch(commands[0] ?? "", /install -m 755 "\$\(command -v gh\)"/u);
});
