import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify, parseEnv } from "node:util";
const execute = promisify(execFile);

test("standalone setup provisions in an arbitrary team, preserves credentials and never registers with a relay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eve-standalone-setup-"));
  try {
    await mkdir(join(dir, ".vercel"));
    await mkdir(join(dir, "bin"));
    const pkg = join(dir, "node_modules/@eve-start/eve");
    await mkdir(pkg, { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        type: "module",
        exports: { ".": "./index.js", "./provision": "./provision.js" },
      }),
    );
    await writeFile(
      join(pkg, "index.js"),
      "function start(){}; start.config={redirectHomepage:true}; export default start;",
    );
    await writeFile(
      join(pkg, "provision.js"),
      `import {appendFileSync} from 'node:fs';
      function record(kind, options) { if(process.env.VERCEL_OIDC_TOKEN!=='own-project-identity') throw Error('Wrong identity'); appendFileSync('provisioned.jsonl',JSON.stringify({kind,secret:options.secret||options.agentToken,agentId:options.agentId})+'\\n'); }
      export async function prepareAppDatabase(options){record('database',options)}
      export async function prepareBrowserImage(options){record('browser',options)}
    `,
    );
    await writeFile(
      join(dir, ".vercel/project.json"),
      JSON.stringify({ projectId: "prj_personal", orgId: "team_any_other_team" }),
    );
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ type: "module", dependencies: { "@eve-start/eve": "*" } }),
    );
    await writeFile(
      join(dir, "bin/vercel"),
      `#!/usr/bin/env node
      import fs from 'node:fs';
      const args=process.argv.slice(2);
      if(args[0]==='env') fs.writeFileSync(args[2], 'VERCEL_OIDC_TOKEN=own-project-identity\\n'+(fs.existsSync('remote.env')?fs.readFileSync('remote.env','utf8'):''));
      else if(args[0]==='api') {
        fs.appendFileSync('api-calls',args[1]+'\\n');
        if(args[1].includes('/env?')) {
          const entry=JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1],'utf8'));
          fs.appendFileSync('remote.env',entry.key+'='+entry.value+'\\n');
          console.log('{}');
        } else console.log(JSON.stringify({id:'prj_personal',name:'My agent',passport:{},protectionBypass:{personal_bypass_token_123456:{scope:'automation-bypass'}}}));
      } else process.exit(1);
    `,
      { mode: 0o700 },
    );
    const init = new URL("../apps/cli/src/init.ts", import.meta.url).href;
    const code = `globalThis.fetch=()=>{throw Error('Setup must not contact a relay')}; const {initialize}=await import(${JSON.stringify(init)}); await initialize();`;
    const env = { PATH: join(dir, "bin") + ":" + process.env.PATH, HOME: process.env.HOME };
    const run = () =>
      execute(process.execPath, ["--conditions=development", "--input-type=module", "-e", code], {
        cwd: dir,
        env,
      });
    const first = await run();
    const source = await readFile(join(dir, ".env.local"), "utf8");
    const values = parseEnv(source);
    assert.ok(values.EVE_START_AGENT_ID);
    assert.ok(values.EVE_START_AGENT_TOKEN);
    assert.match(values.EVE_START_AGENT_ID, /^app-[a-f0-9]{32}$/);
    assert.match(values.EVE_START_AGENT_TOKEN, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(values.EVE_START_APP_BYPASS_TOKEN, "personal_bypass_token_123456");
    assert.equal(values.EVE_START_RELAY_URL, undefined);
    assert.equal((await stat(join(dir, ".env.local"))).mode & 0o777, 0o600);
    assert.ok(!first.stdout.includes(values.EVE_START_AGENT_TOKEN));
    const calls = (await readFile(join(dir, "provisioned.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls.map((call: any) => call.kind),
      ["database", "browser"],
    );
    assert.equal(calls[0].secret, values.EVE_START_AGENT_TOKEN);
    assert.equal(calls[1].agentId, values.EVE_START_AGENT_ID);
    await writeFile(
      join(dir, "agent/extensions/start.ts"),
      "import start from '@eve-start/eve';\nexport default start({name:'Custom'});\n",
    );
    await run();
    assert.equal(
      parseEnv(await readFile(join(dir, ".env.local"), "utf8")).EVE_START_AGENT_TOKEN,
      values.EVE_START_AGENT_TOKEN,
    );
    assert.match(await readFile(join(dir, "agent/extensions/start.ts"), "utf8"), /Custom/);
    assert.ok(!(await readFile(join(dir, "api-calls"), "utf8")).includes("deployments"));
    // A mismatched local credential must not overwrite local or remote state.
    const mismatched = source.replace(values.EVE_START_AGENT_TOKEN, "a".repeat(43));
    await writeFile(join(dir, ".env.local"), mismatched);
    await assert.rejects(run(), /Local and deployed agent credentials differ/);
    assert.equal(await readFile(join(dir, ".env.local"), "utf8"), mismatched);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
