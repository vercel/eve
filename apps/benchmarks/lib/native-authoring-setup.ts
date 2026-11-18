import type { Sandbox } from "@vercel/agent-eval";

import type { AuthoringSetup, AuthoringSetupContext } from "./authoring-case.js";
import { crmLocalEnvSetup } from "./setups/crm-local-env.js";
import { helpdeskExtensionSetup } from "./setups/helpdesk-extension.js";
import { inventoryOpenApiSetup } from "./setups/inventory-openapi.js";
import { northstarFulfillmentSetup } from "./setups/northstar-fulfillment.js";
import { tallyAppSetup } from "./setups/tally-app.js";
import { vercelSetup } from "./setups/vercel.js";

const sessionSetups: readonly AuthoringSetup[] = [
  crmLocalEnvSetup,
  helpdeskExtensionSetup,
  inventoryOpenApiSetup,
  northstarFulfillmentSetup,
  tallyAppSetup,
  vercelSetup,
];

interface FixtureBootstrap {
  readonly startingPoint: "scaffolded" | "empty";
  readonly projectDirectory?: string;
  readonly skipSandboxPrewarm?: boolean;
  readonly revision: string;
  readonly setupIds: readonly string[];
}

/** Must satisfy eve's `just-bash` peer range; matches the version eve tests against. */
export const JUST_BASH_VERSION = "3.6.0";
/** Matches the workspace catalog, so it accepts the `vite` version eve's peer range requires. */
export const VITEST_VERSION = "5.0.2";

/**
 * OpenCode asks before some tool calls, and a run has nobody to answer: the request is
 * rejected and the session ends. agent-eval's project `opencode.json` allows writes, edits, and
 * commands, but OpenCode's defaults still ask before touching anything outside the project,
 * before reading `.env` files, and after three identical calls in a row (`doom_loop`). Agents
 * stopped at `cat /usr/local/bin/eve-benchmark-build` and at reading the case's `.env.local`.
 * OpenCode merges its global config under
 * the project's, so this adds the permission without replacing agent-eval's file. Other
 * harnesses never read it, so every run gets it.
 */
export const OPENCODE_GLOBAL_CONFIG = `${JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  permission: { external_directory: "allow", read: "allow", doom_loop: "allow" },
})}\n`;

/** The selected canary, installed once before the model starts. */
export const EVE_CANARY_PREFIX = "/usr/local/lib/eve-benchmark";

/**
 * The `eve` on PATH. Inside a project it runs that project's installed binary, the way a
 * user's `eve` resolves; anywhere else, such as `eve init` in an empty workspace, it runs the
 * canary installed during setup. Running `npx --package=<tarball>` here instead re-resolved the
 * remote tarball on every call and charged several seconds to the model each time (7.8 s vs
 * 0.6 s for `--help` at p50).
 */
export const EVE_WRAPPER = `#!/bin/sh
dir=$PWD
while :; do
  if [ -x "$dir/node_modules/.bin/eve" ]; then exec "$dir/node_modules/.bin/eve" "$@"; fi
  [ "$dir" = / ] && break
  dir=$(dirname "$dir")
done
exec ${EVE_CANARY_PREFIX}/node_modules/.bin/eve "$@"
`;

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
    await run(
      sandbox,
      `mkdir -p ${EVE_CANARY_PREFIX} && npm install --prefix ${EVE_CANARY_PREFIX} --no-save --no-package-lock --no-audit --no-fund --allow-remote=all ${shellQuote(options.packageSpec)}`,
      "eve canary install",
    );
    await sandbox.writeFiles({ "/usr/local/bin/eve": EVE_WRAPPER });
    await run(sandbox, "chmod +x /usr/local/bin/eve", "eve wrapper");

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
      let build = `npm --prefix ${bootstrap.projectDirectory} run build`;
      if (bootstrap.skipSandboxPrewarm === true) {
        // Kept outside the workspace so the flag doesn't hint at the case's answer.
        build = "eve-benchmark-build";
        await sandbox.writeFiles({
          "/usr/local/bin/eve-benchmark-build": `#!/bin/sh\ncd ${shellQuote(bootstrap.projectDirectory)} && exec npm exec -- eve build --skip-sandbox-prewarm\n`,
        });
        await run(sandbox, "chmod +x /usr/local/bin/eve-benchmark-build", "build wrapper");
      }
      await sandbox.writeFiles({
        "package.json": `${JSON.stringify({
          private: true,
          scripts: {
            typecheck: `npm --prefix ${bootstrap.projectDirectory} run typecheck`,
            build,
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

    const context = setupContext(sandbox, options.packageSpec, bootstrap.projectDirectory);
    for (const setup of setups) await setup.onSession?.(context);
    if (options.treatment === "baseline") await run(sandbox, "rm -f AGENTS.md CLAUDE.md GEMINI.md");
    if (bootstrap.startingPoint === "scaffolded") {
      await run(sandbox, "npm run typecheck && npm run build", "starting workspace validation");
    }
    await run(
      sandbox,
      `dir="\${XDG_CONFIG_HOME:-$HOME/.config}/opencode" && mkdir -p "$dir" && printf '%s' ${shellQuote(OPENCODE_GLOBAL_CONFIG)} > "$dir/opencode.json"`,
      "OpenCode permissions",
    );
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

function setupContext(
  sandbox: Sandbox,
  packageSpec: string,
  projectDirectory?: string,
): AuthoringSetupContext {
  const workspace =
    projectDirectory === undefined
      ? sandbox.getWorkingDirectory()
      : `${sandbox.getWorkingDirectory()}/${projectDirectory}`;
  return {
    workspace,
    artifactsRoot: "/tmp/photon",
    packageSpec,
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
