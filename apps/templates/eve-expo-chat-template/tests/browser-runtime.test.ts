import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentBrowserRunner, browserArgs } from "@eve-start/browser-runtime";
test("the native runner fixes the connection and session while preserving browser arguments without shell execution", async () => {
  assert.throws(
    () => browserArgs(["--cdp", "https://attacker.example", "tab"], "own"),
    /connection settings/,
  );
  assert.throws(() => browserArgs(["cookies"], "own"), /official browser/);
  assert.throws(() => browserArgs(["sh", "-c", "whoami"], "own"), /official browser/);
  const directory = await mkdtemp(join(tmpdir(), "eve-browser-"));
  try {
    const binary = join(directory, "native-test");
    await writeFile(
      binary,
      "#!/usr/bin/env node\nconsole.log(JSON.stringify({success:true,data:{args:process.argv.slice(2)},error:null}));\n",
      { mode: 0o700 },
    );
    const runner = new AgentBrowserRunner({ binary, cdp: "9222", session: "own-session" });
    const result = await runner.execute({
      type: "agent-browser",
      args: ["--session", "other-session", "eval", '"$HOME; touch /tmp/not-run"'],
    });
    assert.equal(result.exitCode, 0);
    const args = JSON.parse(result.stdout).data.args;
    assert.deepEqual(args.slice(0, 4), ["--cdp", "9222", "--session", "own-session"]);
    assert.ok(args.includes('"$HOME; touch /tmp/not-run"'));
    assert.ok(!args.includes("other-session"));
    const local = new AgentBrowserRunner({ binary, session: "local" });
    const probe = await local.execute({ type: "agent-browser", args: ["tab"] });
    assert.equal(JSON.parse(probe.stdout).data.args[0], "--auto-connect");
    assert.equal(await local.ready(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
