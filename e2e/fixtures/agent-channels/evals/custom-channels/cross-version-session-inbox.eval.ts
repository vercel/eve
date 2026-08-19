import { execFile } from "node:child_process";
import { readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { defineEval } from "eve/evals";
import type { EveEvalContext } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { postChannel } from "./shared";

const ALIAS_ENV = "EVE_E2E_REDEPLOY_ALIAS";
const BASE_EVE_PACKAGE_ENV = "EVE_E2E_BASE_EVE_PACKAGE";
const OLD_EVE_VERSION = "0.30.8";
const ACTIVE_TURN_MESSAGE = "Please wait for cross-version follow-up.";

const INSTRUCTIONS_PATH = resolve("agent", "instructions.md");
const FIXTURE_EVE_LINK = resolve("node_modules", "eve");
const CONFIG_EVE_LINK = resolve("..", "e2e-config", "node_modules", "eve");
const OLD_EVE_PACKAGE = resolve("node_modules", "historical-eve-0-30-8");

const OLD_DEPLOYMENT_MARKER = "cross-version-eve-0-30-8";
const BASE_DEPLOYMENT_MARKER = "cross-version-eve-pr-base";
const CURRENT_DEPLOYMENT_MARKER = "cross-version-eve-current";
const TOOL_NAME = "wait-for-cancellation";

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { maxBuffer: 64 * 1024 * 1024 } as const;

type MessageResponse = { ok: boolean; sessionId?: string };

/**
 * Proves the complete mixed-version codec boundary through real Workflow
 * hooks. The current producer must resume both the PR-base consumer (the
 * generic upgrade invariant) and the published eve@0.30.8 consumer (the
 * historical regression) without either consumer recompiling.
 */
export default defineEval({
  description:
    "Session inbox: the current producer resumes PR-base and eve@0.30.8 consumers through durable hooks.",
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
    const baseEvePackage = process.env[BASE_EVE_PACKAGE_ENV];
    if (baseEvePackage === undefined || baseEvePackage.length === 0) {
      throw new Error(
        `Requires ${BASE_EVE_PACKAGE_ENV}; the e2e-vercel job must build the PR-base eve package.`,
      );
    }

    const originalInstructions = await readFile(INSTRUCTIONS_PATH, "utf8");
    const links = await Promise.all([
      snapshotLink(FIXTURE_EVE_LINK),
      snapshotLink(CONFIG_EVE_LINK),
    ]);
    const currentEvePackage = await realpath(FIXTURE_EVE_LINK);
    const currentEveVersion = await readPackageVersion(currentEvePackage);
    const oldEvePackage = await realpath(OLD_EVE_PACKAGE);
    const oldEveVersion = await readPackageVersion(oldEvePackage);
    const resolvedBaseEvePackage = await realpath(baseEvePackage);
    const baseEveVersion = await readPackageVersion(resolvedBaseEvePackage);
    if (oldEveVersion !== OLD_EVE_VERSION) {
      throw new Error(
        `Expected ${OLD_EVE_PACKAGE} to resolve eve@${OLD_EVE_VERSION}; got eve@${oldEveVersion}.`,
      );
    }

    try {
      const pinnedConsumers = [
        await deployAndStartConsumer(t, alias, links, originalInstructions, {
          deploymentMarker: OLD_DEPLOYMENT_MARKER,
          evePackage: oldEvePackage,
          followUpToken: "EVE-0-30-8-WIRE-OK",
          label: "eve@0.30.8",
        }),
        await deployAndStartConsumer(t, alias, links, originalInstructions, {
          deploymentMarker: BASE_DEPLOYMENT_MARKER,
          evePackage: resolvedBaseEvePackage,
          followUpToken: "PR-BASE-WIRE-OK",
          label: `PR-base eve@${baseEveVersion}`,
        }),
      ];

      await restoreLinks(links);
      await writeFile(
        INSTRUCTIONS_PATH,
        `${originalInstructions}\nDeployment marker: ${CURRENT_DEPLOYMENT_MARKER}.\n`,
      );
      await deployToAlias(t, alias, `eve@${currentEveVersion}`);
      await waitForAliasToServe(t, CURRENT_DEPLOYMENT_MARKER);

      for (const consumer of pinnedConsumers) {
        const replacement = await postChannel<MessageResponse>(t.target, "/cross-version-webhook", {
          message: `Reply with exactly ${consumer.followUpToken}.`,
          sessionRef: consumer.sessionRef,
          turnPolicy: "queue",
        });
        await t.require(
          replacement,
          satisfies(
            (value: MessageResponse) => value.ok === true && value.sessionId === consumer.sessionId,
            `the current producer targets the existing ${consumer.label} session`,
          ),
        );
      }

      // Both consumers must buffer the queued value before cancellation. The
      // next turn proves the pinned decoder retained what the current producer
      // persisted; merely accepting resumeHook is not sufficient.
      await t.sleep(1_000);
      for (const consumer of pinnedConsumers) {
        const cancellation = await consumer.activeTurn.cancel();
        await t.require(
          cancellation,
          satisfies(
            (value: { readonly sessionId?: string; readonly status: string }) =>
              value.status === "accepted" && value.sessionId === consumer.sessionId,
            `the current deployment cancels the active ${consumer.label} turn`,
          ),
        );

        const cancelled = await consumer.activeTurn.result();
        cancelled.event("turn.cancelled", { count: 1 });
        cancelled.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
        cancelled.notEvent("turn.failed");
        cancelled.notEvent("session.failed");

        const followUp = await t.target
          .watchTurn(consumer.sessionId, { startIndex: cancelled.events.length })
          .result();
        followUp.notEvent("turn.cancelled");
        followUp.notEvent("turn.failed");
        followUp.notEvent("session.failed");
        followUp.messageIncludes(consumer.followUpToken);
      }

      t.succeeded();
    } finally {
      await restoreLinks(links);
      await writeFile(INSTRUCTIONS_PATH, originalInstructions);
    }
  },
});

async function deployAndStartConsumer(
  t: EveEvalContext,
  alias: string,
  links: readonly LinkSnapshot[],
  originalInstructions: string,
  input: {
    readonly deploymentMarker: string;
    readonly evePackage: string;
    readonly followUpToken: string;
    readonly label: string;
  },
) {
  for (const link of links) {
    await replaceLink(link.path, input.evePackage);
  }
  await writeFile(
    INSTRUCTIONS_PATH,
    `${originalInstructions}\nDeployment marker: ${input.deploymentMarker}.\n`,
  );
  await deployToAlias(t, alias, input.label);
  await waitForAliasToServe(t, input.deploymentMarker);

  const sessionRef = crypto.randomUUID();
  const started = await postChannel<MessageResponse>(t.target, "/cross-version-webhook", {
    message: ACTIVE_TURN_MESSAGE,
    sessionRef,
  });
  await t.require(
    started,
    satisfies(
      (value: MessageResponse) => value.ok === true && typeof value.sessionId === "string",
      `${input.label} starts the durable session`,
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

  return {
    activeTurn,
    followUpToken: input.followUpToken,
    label: input.label,
    sessionId,
    sessionRef,
  };
}

interface LinkSnapshot {
  readonly path: string;
  readonly target: string;
}

async function snapshotLink(path: string): Promise<LinkSnapshot> {
  return { path, target: await readlink(path) };
}

async function replaceLink(path: string, target: string): Promise<void> {
  await rm(path, { force: true });
  await symlink(target, path);
}

async function restoreLinks(links: readonly LinkSnapshot[]): Promise<void> {
  for (const link of links) {
    await replaceLink(link.path, link.target);
  }
}

async function readPackageVersion(packagePath: string): Promise<string> {
  const manifest = JSON.parse(await readFile(resolve(packagePath, "package.json"), "utf8")) as {
    version?: string;
  };
  if (manifest.version === undefined) {
    throw new Error(`Package at ${packagePath} has no version.`);
  }
  return manifest.version;
}

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
  while (Date.now() < deadline) {
    const response = await t.target.fetch("/eve/v1/info");
    if (response.ok && JSON.stringify(await response.json()).includes(marker)) {
      return;
    }
    await t.sleep(1_000);
  }
  throw new Error(`Timed out waiting for the alias to serve a deployment containing ${marker}.`);
}
