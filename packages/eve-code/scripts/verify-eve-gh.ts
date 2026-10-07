import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eveGhImplementation } from "../extension/lib/eve-gh-sandbox.ts";
import { withDevboxCredentials } from "../extension/lib/devbox-credentials.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before running the live sandbox check.`);
  return value;
}

const repository = required("EVE_GH_REPOSITORY");
const revision = required("EVE_GH_REVISION");
assert.match(revision, /^[a-f0-9]{40}$/i, "Use a full commit SHA for the live check");
const options = {
  enabled: true,
  repository,
  revision,
  token: required("EVE_GH_CHECK_TOKEN"),
  teamId: required("VERCEL_TEAM_ID"),
  projectId: required("VERCEL_PROJECT_ID"),
  commitAs: {
    name: required("EVE_GH_CHECK_NAME"),
    email: required("EVE_GH_CHECK_EMAIL"),
  },
  timeout: 120_000,
};
const provider = withDevboxCredentials(
  eveGhImplementation(() => options),
  () => options,
);
const context = {
  host: {} as never,
  session: {
    auth: { current: null, initiator: null },
    id: `eve-code-check-${randomUUID()}`,
    turn: { id: "eve-gh-check", sequence: 0 },
  },
  storagePath: process.cwd(),
};
const started = await provider.start(context, undefined, {});
const state = started.state;
let handle = started.handle;

try {
  async function git(...args: string[]): Promise<string> {
    const command = ["git", ...args].map((arg) => `'${arg.replaceAll("'", `'"'"'`)}'`).join(" ");
    const result = await handle.sandbox.run({ command });
    assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  }

  assert.equal(await git("rev-parse", "HEAD"), revision, "Sandbox checked out the wrong revision");
  assert.equal(await git("status", "--porcelain"), "", "Checkout is not clean");
  assert.equal(await git("remote", "get-url", "origin"), repository);
  await git("ls-remote", "--exit-code", "origin", "HEAD");
  const credentialCheck = await handle.sandbox.run({
    command: `node -e 'Promise.all([
      fetch("https://api.vercel.com/v2/user", { headers: { authorization: "Bearer " + process.env.VERCEL_TOKEN } }),
      fetch("https://api.github.com/user", { headers: { authorization: "Bearer " + process.env.GH_TOKEN, "user-agent": "eve-code-check" } })
    ]).then(responses => { if (responses.some(response => !response.ok)) process.exitCode = 1; })
      .catch(() => { process.exitCode = 1; });'`,
  });
  assert.equal(credentialCheck.exitCode, 0, "Runtime user credential check failed");
  await handle.onSessionStop();
  handle = await provider.resume(context, {}, state);
  assert.equal(await git("rev-parse", "HEAD"), revision, "Resume lost the checkout");
  await git("ls-remote", "--exit-code", "origin", "HEAD");
  console.log(JSON.stringify({ sandbox: state.sandboxName, revision, cloneReadResume: "passed" }));
  console.log("This read-only check does not verify push or signed commits.");
} finally {
  await handle.onSessionDelete();
}
