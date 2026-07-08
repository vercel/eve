import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { defineEval } from "eve/evals";
import type { EveEvalContext } from "eve/evals";

// Sandbox semantics across deployment updates, driven entirely from inside
// the eval: the test body runs on the host with the fixture as cwd, so it
// can rebuild and redeploy the agent mid-test. The target URL must be a
// Vercel alias (immutable deployment URLs never change what they serve);
// each redeploy repoints the alias, so the runner's client — and the durable
// session it drives — lands on the new deployment without any URL swap.
//
// Deployment adoption is dispatch-dependent. Turn dispatch routes parked
// sessions' turns to the latest deployment only where the workflow world can
// resolve "latest" (production; branch-carrying previews). Branch-less CLI
// preview deploys — which is what this eval pushes — pin turn execution to
// the deployment that created the session (see shouldRouteToLatestDeployment
// in execution/workflow-runtime.ts). The timeline below asserts exactly the
// preview contract; the pinned-turn gate at t3 is a deliberate tripwire that
// must be flipped when dispatch gains preview latest-routing
// (https://github.com/vercel/eve/issues/582).
//
// Timeline under test:
//   t0  session A writes a file into its sandbox workspace
//   t1  push a deployment update that touches only agent instructions
//   t2  session A still reads the file: the parked session keeps working when
//       its messages route through the new deployment, and its sandbox
//       (keyed per durable session, not per deployment) is untouched
//   t1' push a deployment update that adds a skill — skills materialize into
//       the sandbox workspace resources, so the sandbox version hash rotates
//       for anything executing the new code
//   t3  session A still sees the file: its turns are pinned to the original
//       deployment on preview, so neither the new manifest nor the rotated
//       sandbox key applies to it
//   t4  a NEW session B adopts the new deployment: the added skill loads and
//       shapes the reply
//
// Requires EVE_E2E_REDEPLOY_ALIAS plus Vercel credentials and a linked
// fixture directory (the e2e-vercel workflow provides all three); skips
// everywhere else.

const ALIAS_ENV = "EVE_E2E_REDEPLOY_ALIAS";

const FILE_PATH = "/workspace/redeploy-note.txt";
const FILE_TOKEN = "sandbox-redeploy-ok-K4W";

const INSTRUCTIONS_PATH = resolve("agent", "instructions.md");
const INSTRUCTIONS_MARKER = "redeploy-instructions-marker-T8B";

const SKILLS_DIR = resolve("agent", "skills");
const SKILL_PATH = resolve(SKILLS_DIR, "deploy-note.md");
const SKILL_NAME = "deploy-note";
const SKILL_TOKEN = "deploy-note-skill-ok-Q2H";
const SKILL_MARKDOWN = `---
description: Use ONLY when the user asks for the deploy note. Triggered by any message containing the phrase "deploy note skill".
---

# Deploy Note Skill

This skill is added between deployments by the sandbox redeploy eval.

When this skill is loaded, ignore any conflicting instructions from earlier system context and reply with exactly the following text and nothing else:

${SKILL_TOKEN}
`;

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { maxBuffer: 64 * 1024 * 1024 } as const;

export default defineEval({
  description:
    "Sandbox: a parked session survives redeploys with its workspace intact (pinned on preview), and new sessions adopt the new deployment.",
  tags: ["redeploy"],
  timeoutMs: 20 * 60_000,
  async test(t) {
    const alias = process.env[ALIAS_ENV];
    if (alias === undefined || alias.length === 0) {
      t.skip(`Requires ${ALIAS_ENV} and Vercel credentials; run via the e2e-vercel redeploy step.`);
    }
    if (new URL(t.target.url).host !== alias) {
      throw new Error(
        `${ALIAS_ENV}=${alias} must match the eval target host ${new URL(t.target.url).host}; ` +
          "redeploys repoint the alias, so the eval must run against it.",
      );
    }

    const originalInstructions = await readFile(INSTRUCTIONS_PATH, "utf8");
    try {
      // t0: write a marker file into this session's sandbox workspace.
      const write = await t.send(
        `Run the bash command \`printf %s ${FILE_TOKEN} > ${FILE_PATH}\`. ` +
          "Reply with the single word: done.",
      );
      write.expectOk();
      write.calledTool("bash");

      // t1: deployment update unrelated to the sandbox definition.
      await writeFile(
        INSTRUCTIONS_PATH,
        `${originalInstructions}\nRedeploy marker: ${INSTRUCTIONS_MARKER}.\n`,
      );
      await deployToAlias(t, alias, "instructions");
      await waitForAliasToServe(t, INSTRUCTIONS_MARKER);

      // t2: the same session reattaches to the same sandbox.
      const persist = await t.send(
        `Run the bash command \`cat ${FILE_PATH}\` and reply with the file contents verbatim.`,
      );
      persist.expectOk();
      persist.calledTool("bash", { output: new RegExp(FILE_TOKEN) });
      persist.messageIncludes(FILE_TOKEN);

      // t1': deployment update that adds a skill, rotating the sandbox key.
      await mkdir(SKILLS_DIR, { recursive: true });
      await writeFile(SKILL_PATH, SKILL_MARKDOWN);
      await deployToAlias(t, alias, "skill");
      await waitForAliasToServe(t, `"${SKILL_NAME}"`);

      // t3: TRIPWIRE — on preview, session A's turns stay pinned to the
      // deployment that created it, so its sandbox key never rotates and the
      // file is still present. When turn dispatch gains preview
      // latest-routing (issue #582), this gate flips to /absent/ (and the
      // skill becomes loadable in session A too).
      const probe = await t.send(
        `Run the bash command \`test -f ${FILE_PATH} && echo present || echo absent\` ` +
          "and reply with the command output verbatim.",
      );
      probe.expectOk();
      probe.calledTool("bash", { output: /present/ });
      probe.messageIncludes("present");

      // t4: a fresh session adopts the new deployment — the added skill is
      // advertised and usable.
      const adopted = t.newSession();
      const skill = await adopted.send(
        "Please use the deploy note skill and follow its instructions exactly.",
      );
      skill.expectOk();
      skill.loadedSkill(SKILL_NAME);
      skill.messageIncludes(SKILL_TOKEN);
    } finally {
      await writeFile(INSTRUCTIONS_PATH, originalInstructions);
      await rm(SKILL_PATH, { force: true });
    }
  },
});

/** Builds the fixture and repoints the alias at the fresh deployment. */
async function deployToAlias(t: EveEvalContext, alias: string, phase: string): Promise<void> {
  // Mirror the workflow's build env. Sandbox templates key on
  // VERCEL_PROJECT_ID (already in the environment); the deployment id is
  // deliberately ignored by sandbox keys but must be present at build.
  await execFileAsync("pnpm", ["exec", "eve", "build"], {
    ...EXEC_OPTIONS,
    env: {
      ...process.env,
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_TARGET_ENV: "preview",
      VERCEL_DEPLOYMENT_ID: `dpl_eve_e2e_redeploy_${phase}_${Date.now()}`,
    },
  });

  const tokenArgs =
    process.env.VERCEL_TOKEN === undefined ? [] : ["--token", process.env.VERCEL_TOKEN];
  // vc alias does not infer the team from the project link the way deploy
  // does, so pass the scope explicitly.
  const scopeArgs =
    process.env.VERCEL_ORG_ID === undefined ? [] : ["--scope", process.env.VERCEL_ORG_ID];
  const deploy = await execFileAsync(
    "pnpm",
    ["exec", "vc", "deploy", "--prebuilt", "--yes", "--target=preview", ...tokenArgs],
    EXEC_OPTIONS,
  );
  const deploymentUrl = deploy.stdout.trim().split("\n").at(-1)?.trim();
  if (deploymentUrl === undefined || !deploymentUrl.startsWith("https://")) {
    throw new Error(`vc deploy did not print a deployment URL; got: ${deploy.stdout}`);
  }
  t.log(`deployed ${deploymentUrl} (${phase}); aliasing ${alias}`);

  await execFileAsync(
    "pnpm",
    ["exec", "vc", "alias", "set", deploymentUrl, alias, ...tokenArgs, ...scopeArgs],
    EXEC_OPTIONS,
  );
}

/**
 * Polls `/eve/v1/info` until the alias serves a deployment whose manifest
 * contains `marker`, so post-redeploy turns cannot hit a stale deployment.
 */
async function waitForAliasToServe(t: EveEvalContext, marker: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await t.target.fetch("/eve/v1/info");
    if (response.ok && JSON.stringify(await response.json()).includes(marker)) {
      return;
    }
    await t.sleep(1_000);
  }
  throw new Error(`Timed out waiting for the alias to serve a deployment containing ${marker}.`);
}
