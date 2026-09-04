import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { defineEval } from "eve/evals";
import type { EveEvalContext } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { postChannel } from "./shared";

const ALIAS_ENV = "EVE_E2E_REDEPLOY_ALIAS";
const ACTIVE_TURN_MESSAGE = "Please wait for cross-version follow-up.";
const FOLLOW_UP_TOKEN = "CROSS-VERSION-WIRE-OK";

const INSTRUCTIONS_PATH = resolve("agent", "instructions.md");
const OLD_DEPLOYMENT_MARKER = "session-inbox-before-redeploy";
const CURRENT_DEPLOYMENT_MARKER = "session-inbox-after-redeploy";
const TOOL_NAME = "wait-for-cancellation";

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { maxBuffer: 64 * 1024 * 1024 } as const;

type MessageResponse = { ok: boolean; sessionId?: string };

export default defineEval({
  description:
    "Session inbox: a redeployed producer resumes an active session through metadata-free hooks.",
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
      await writeFile(
        INSTRUCTIONS_PATH,
        `${originalInstructions}\nDeployment marker: ${OLD_DEPLOYMENT_MARKER}.\n`,
      );
      await deployToAlias(t, alias, "before redeploy");
      await waitForAliasToServe(t, OLD_DEPLOYMENT_MARKER);

      const sessionRef = crypto.randomUUID();
      const started = await postChannel<MessageResponse>(t.target, "/cross-version-webhook", {
        message: ACTIVE_TURN_MESSAGE,
        sessionRef,
      });
      await t.require(
        started,
        satisfies(
          (value: MessageResponse) => value.ok === true && typeof value.sessionId === "string",
          "the first deployment starts the durable session",
        ),
      );
      const sessionId = started.sessionId!;
      const activeTurn = t.target.watchTurn(sessionId);

      await activeTurn.waitForEvent("actions.requested", {
        data: {
          actions: (actions) =>
            actions.some((action) => action.kind === "tool-call" && action.toolName === TOOL_NAME),
        },
      });

      await writeFile(
        INSTRUCTIONS_PATH,
        `${originalInstructions}\nDeployment marker: ${CURRENT_DEPLOYMENT_MARKER}.\n`,
      );
      await deployToAlias(t, alias, "after redeploy");
      await waitForAliasToServe(t, CURRENT_DEPLOYMENT_MARKER);

      const replacement = await postChannel<MessageResponse>(t.target, "/cross-version-webhook", {
        message: `Reply with exactly ${FOLLOW_UP_TOKEN}.`,
        sessionRef,
        turnPolicy: "queue",
      });
      await t.require(
        replacement,
        satisfies(
          (value: MessageResponse) => value.ok === true && value.sessionId === sessionId,
          "the new deployment targets the existing session",
        ),
      );

      // Settle the blocked turn after queuing the follow-up on the old deployment.
      await t.sleep(1_000);
      const cancellation = await activeTurn.cancel();
      await t.require(
        cancellation,
        satisfies(
          (value: { readonly sessionId?: string; readonly status: string }) =>
            value.status === "accepted" && value.sessionId === sessionId,
          "the new deployment cancels the active turn",
        ),
      );

      const cancelled = await activeTurn.result();
      cancelled.event("turn.cancelled", { count: 1 });
      cancelled.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
      cancelled.notEvent("turn.failed");
      cancelled.notEvent("session.failed");

      const followUp = await t.target
        .watchTurn(sessionId, { startIndex: cancelled.events.length })
        .result();
      followUp.notEvent("turn.cancelled");
      followUp.notEvent("turn.failed");
      followUp.notEvent("session.failed");
      followUp.messageIncludes(FOLLOW_UP_TOKEN);

      t.succeeded();
    } finally {
      await writeFile(INSTRUCTIONS_PATH, originalInstructions);
    }
  },
});

/** Builds the fixture and repoints the run-scoped alias at the fresh deployment. */
async function deployToAlias(t: EveEvalContext, alias: string, phase: string): Promise<void> {
  await execFileAsync("pnpm", ["exec", "eve", "build"], {
    ...EXEC_OPTIONS,
    env: {
      ...process.env,
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_TARGET_ENV: "preview",
    },
  });
  const tokenArgs =
    process.env.VERCEL_TOKEN === undefined ? [] : ["--token", process.env.VERCEL_TOKEN];
  const modelArgs =
    process.env.EVE_E2E_MODEL === undefined
      ? []
      : ["--env", `EVE_E2E_MODEL=${process.env.EVE_E2E_MODEL}`];
  const scopeArgs =
    process.env.VERCEL_ORG_ID === undefined ? [] : ["--scope", process.env.VERCEL_ORG_ID];
  const deploy = await execFileAsync(
    "pnpm",
    ["exec", "vc", "deploy", "--prebuilt", "--yes", "--target=preview", ...modelArgs, ...tokenArgs],
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

/** Waits until the alias exposes the marker from the expected deployment. */
async function waitForAliasToServe(t: EveEvalContext, marker: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastStatus = "transport error";
  let lastMarkerMatch = false;
  while (Date.now() < deadline) {
    try {
      const response = await t.target.fetch("/eve/v1/info", { cache: "no-store" });
      lastStatus = String(response.status);
      lastMarkerMatch = response.ok && JSON.stringify(await response.json()).includes(marker);
      if (lastMarkerMatch) return;
    } catch {
      // The alias may briefly be unavailable while its deployment propagates.
    }
    await t.sleep(1_000);
  }
  throw new Error(
    `Timed out waiting for alias ${new URL(t.target.url).host} to serve marker ${marker}; ` +
      `last status=${lastStatus}, marker matched=${lastMarkerMatch}.`,
  );
}
