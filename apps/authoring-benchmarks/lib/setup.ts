import { readFileSync } from "node:fs";

import type { Sandbox } from "@vercel/agent-eval";

const TARBALL_PATH = "__authoring_eval__/eve.tgz";
const REGISTRY_ROOT = "__authoring_eval__/registry";
const SEED_ROOT = "__authoring_eval__/seed";

export interface SetupAuthoringEvalOptions {
  readonly agentsMd?: boolean;
  readonly syntheticImessage?: boolean;
}

/** Installs the exact eve package prepared by the authoring-eval runner. */
export async function setupAuthoringEval(
  sandbox: Sandbox,
  options: SetupAuthoringEvalOptions = {},
): Promise<void> {
  const tarball = process.env.EVE_AUTHORING_TARBALL;
  if (tarball === undefined) {
    throw new Error("EVE_AUTHORING_TARBALL is not set. Run through pnpm benchmark:authoring.");
  }

  await run(sandbox, "bash", [
    "-lc",
    `mkdir -p ${SEED_ROOT} && cp -a seed/. ${SEED_ROOT}/ && rm -rf seed package.json package-lock.json`,
  ]);
  await sandbox.writeFiles({
    // agent-eval accepts Buffer at runtime, but its public type currently names only string.
    // @ts-expect-error binary sandbox uploads are supported
    [TARBALL_PATH]: readFileSync(tarball),
  });
  const tarballPath = `${sandbox.getWorkingDirectory()}/${TARBALL_PATH}`;
  await run(sandbox, "npm", [
    "install",
    "--prefix",
    `${SEED_ROOT}/eve-cli`,
    "--package-lock=false",
    "--registry=https://registry.npmjs.org",
    tarballPath,
  ]);
  await run(sandbox, "bash", [
    "-lc",
    `AI_AGENT=benchmark npm_config_user_agent=npm/11 EVE_INIT_PACKAGE_SPEC=${shellQuote(tarballPath)} node ${SEED_ROOT}/eve-cli/node_modules/eve/bin/eve.js init .`,
  ]);
  await run(sandbox, "npm", ["pkg", "set", `dependencies.eve=file:${TARBALL_PATH}`]);

  if (options.syntheticImessage === true) await installSyntheticImessageWorld(sandbox);
  if (options.agentsMd !== true) await removeScaffoldedAgentGuidance(sandbox);
}

async function installSyntheticImessageWorld(sandbox: Sandbox): Promise<void> {
  const registryBaseUrl = "http://127.0.0.1:4173";
  const channel = {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: "channel/mock-imessage",
    title: "Mock iMessage",
    description: "Connect an eve agent to iMessage through a deterministic provider setup flow.",
    files: [
      {
        path: "registry/channels/mock-imessage.ts",
        content: [
          'import { photonIMessageChannel } from "eve/channels/photon";',
          "",
          "async function mockCredentials() {",
          '  return { projectId: "mock-imessage-project", projectSecret: "mock-imessage-secret" };',
          "}",
          "",
          "export default photonIMessageChannel({ credentials: mockCredentials });",
          "",
        ].join("\n"),
        type: "registry:file",
        target: "agent/channels/imessage.ts",
      },
    ],
    meta: {
      eve: {
        docs: "/docs/channels/mock-imessage",
        setup: {
          command: "mock-imessage-setup",
          package: "@eve-internal/mock-imessage-setup",
          bin: "mock-imessage-setup",
          args: [],
        },
      },
    },
    type: "registry:item",
  };
  const catalog = {
    $schema: "https://ui.shadcn.com/schema/registry.json",
    name: "eve-authoring-eval",
    homepage: registryBaseUrl,
    items: [
      {
        name: "channel/mock-imessage",
        type: "registry:item",
        description: channel.description,
        registry: `${registryBaseUrl}/registry.json`,
        addCommandArgument: `${registryBaseUrl}/channel/mock-imessage.json`,
      },
    ],
  };

  await sandbox.writeFiles({
    [`${REGISTRY_ROOT}/registry.json`]: JSON.stringify(catalog),
    [`${REGISTRY_ROOT}/channel/mock-imessage.json`]: JSON.stringify(channel),
  });
  await run(sandbox, "npm", [
    "install",
    "--save",
    "--package-lock=false",
    `./${SEED_ROOT}/mock-imessage-setup`,
  ]);
  await run(sandbox, "bash", [
    "-lc",
    `nohup python3 -m http.server 4173 --directory ${REGISTRY_ROOT} >__authoring_eval__/registry.log 2>&1 </dev/null &`,
  ]);
}

async function removeScaffoldedAgentGuidance(sandbox: Sandbox): Promise<void> {
  await run(sandbox, "rm", ["-f", "AGENTS.md", "CLAUDE.md"]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function run(sandbox: Sandbox, command: string, args: string[]): Promise<void> {
  const result = await sandbox.runCommand(command, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.exitCode}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}
