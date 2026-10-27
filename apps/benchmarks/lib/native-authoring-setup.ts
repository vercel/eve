import type { Sandbox } from "@vercel/agent-eval";

import type { AuthoringSetup, AuthoringSetupContext } from "./authoring-case.js";
import { inventoryOpenApiSetup } from "./setups/inventory-openapi.js";
import { northstarFulfillmentSetup } from "./setups/northstar-fulfillment.js";
import { vercelSetup } from "./setups/vercel.js";

const sessionSetups: readonly AuthoringSetup[] = [
  inventoryOpenApiSetup,
  northstarFulfillmentSetup,
  vercelSetup,
];

interface FixtureBootstrap {
  readonly startingPoint: "scaffolded" | "empty";
  readonly projectDirectory?: string;
  readonly revision: string;
  readonly setupIds: readonly string[];
}

/** Must satisfy eve's `just-bash` peer range; matches the version eve tests against. */
export const JUST_BASH_VERSION = "3.6.0";
/** Matches the workspace catalog, so it accepts the `vite` version eve's peer range requires. */
export const VITEST_VERSION = "5.0.2";

export function createNativeAuthoringSetup(options: {
  readonly packageSpec: string;
  readonly revision: string;
  readonly treatment: "baseline" | "guided";
}) {
  return async (sandbox: Sandbox): Promise<void> => {
    const bootstrap = JSON.parse(
      await sandbox.readFile(".eve-authoring-bootstrap.json"),
    ) as FixtureBootstrap;
    if (bootstrap.revision !== options.revision) {
      throw new Error("Native fixture revision does not match the selected subject.");
    }
    const setups = setupsFor(bootstrap.setupIds);
    await run(
      sandbox,
      "rm -f .eve-authoring-bootstrap.json CASE.ts package.json package-lock.json PROMPT.md",
      "fixture cleanup",
    );
    await sandbox.writeFiles({
      "/usr/local/bin/eve": `#!/bin/sh\nexec npx --yes --allow-remote=all --package=${shellQuote(options.packageSpec)} eve "$@"\n`,
    });
    await run(sandbox, "chmod +x /usr/local/bin/eve", "eve canary wrapper");

    if (bootstrap.startingPoint === "scaffolded") {
      await run(
        sandbox,
        `AI_AGENT=claude EVE_INIT_PACKAGE_SPEC=${shellQuote(options.packageSpec)} eve init . --model openai/gpt-5.5`,
        "workspace bootstrap",
      );
    }

    if (bootstrap.startingPoint === "empty") {
      if (bootstrap.projectDirectory === undefined) {
        throw new Error("An empty native fixture must declare its project directory.");
      }
      await sandbox.writeFiles({
        "package.json": `${JSON.stringify({
          private: true,
          scripts: {
            typecheck: `npm --prefix ${bootstrap.projectDirectory} run typecheck`,
            build: `npm --prefix ${bootstrap.projectDirectory} run build`,
          },
        })}\n`,
      });
    }

    // DefaultSandbox selects just-bash inside the Linux eval container, where Docker
    // is unavailable. Supply its optional peer before the model runs. The grader
    // needs vitest too: agent-eval only installs its fallback `vitest@^3` when the
    // workspace has none, and that fallback fails silently against eve's vite peer.
    // Saving it keeps it through the agent's own `npm install`s.
    await run(
      sandbox,
      `npm install --save-dev --save-exact just-bash@${JUST_BASH_VERSION} vitest@${VITEST_VERSION}`,
      "local sandbox and grader dependencies",
    );

    const context = setupContext(sandbox, bootstrap.projectDirectory);
    for (const setup of setups) await setup.onSession?.(context);
    if (options.treatment === "baseline") await run(sandbox, "rm -f AGENTS.md CLAUDE.md GEMINI.md");
    if (bootstrap.startingPoint === "scaffolded") {
      await run(sandbox, "npm run typecheck && npm run build", "starting workspace validation");
    }
    await run(sandbox, "git add . && git commit --amend --no-edit --quiet");
  };
}

// A case whose setup is skipped would hand the model a workspace without its fixture.
export function setupsFor(ids: readonly string[]): readonly AuthoringSetup[] {
  return ids.map((id) => {
    const setup = sessionSetups.find((candidate) => candidate.id === id);
    if (setup === undefined) {
      throw new Error(`Setup ${JSON.stringify(id)} is not registered with the native runner.`);
    }
    return setup;
  });
}

function setupContext(sandbox: Sandbox, projectDirectory?: string): AuthoringSetupContext {
  const workspace =
    projectDirectory === undefined
      ? sandbox.getWorkingDirectory()
      : `${sandbox.getWorkingDirectory()}/${projectDirectory}`;
  return {
    workspace,
    artifactsRoot: "/tmp/photon",
    run: async (command, workingDirectory = workspace) =>
      run(sandbox, command, command, undefined, workingDirectory),
    write: async (path, content) =>
      sandbox.writeFiles({ [path.startsWith("/") ? path : `${workspace}/${path}`]: content }),
  };
}

async function run(
  sandbox: Sandbox,
  command: string,
  label = command,
  env?: Record<string, string>,
  cwd?: string,
): Promise<void> {
  const result = await sandbox.runCommand(
    "bash",
    ["-lc", `timeout 240 bash -lc ${shellQuote(command)}`],
    {
      env,
      cwd,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (${result.exitCode}):\n${result.stdout}\n${result.stderr}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
