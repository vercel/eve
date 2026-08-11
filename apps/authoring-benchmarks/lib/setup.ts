import { readFileSync } from "node:fs";

import type { Sandbox } from "@vercel/agent-eval";

const TARBALL_PATH = "__authoring_eval__/eve.tgz";
const REGISTRY_ROOT = "__authoring_eval__/registry";
const SEED_ROOT = "__authoring_eval__/seed";
const SCAFFOLD_ROOT = "/tmp/eve-authoring-subject";
const SYNTHETIC_REGISTRY_URL = "http://127.0.0.1:4173";

export interface SetupAuthoringEvalOptions {
  readonly agentsMd?: boolean;
  readonly syntheticImessage?: boolean;
}

/** Installs the exact eve package prepared by the authoring-eval runner. */
export async function setupAuthoringEval(
  sandbox: Sandbox,
  options: SetupAuthoringEvalOptions = {},
): Promise<void> {
  const timings: SetupTiming[] = [];
  const tarball = process.env.EVE_AUTHORING_TARBALL;
  if (tarball === undefined) {
    throw new Error("EVE_AUTHORING_TARBALL is not set. Run through pnpm benchmark:authoring.");
  }

  await measure(timings, "prepare fixture", () =>
    run(sandbox, "bash", [
      "-lc",
      `mkdir -p ${SEED_ROOT} && cp -a seed/. ${SEED_ROOT}/ && rm -rf seed package.json package-lock.json`,
    ]),
  );
  await measure(timings, "upload eve tarball", () =>
    sandbox.writeFiles({
      // agent-eval accepts Buffer at runtime, but its public type currently names only string.
      // @ts-expect-error binary sandbox uploads are supported
      [TARBALL_PATH]: readFileSync(tarball),
    }),
  );
  const tarballPath = `${sandbox.getWorkingDirectory()}/${TARBALL_PATH}`;
  await measure(timings, "extract bootstrap eve CLI", () =>
    run(sandbox, "bash", [
      "-lc",
      `mkdir -p ${SEED_ROOT}/eve-cli && tar -xzf ${TARBALL_PATH} -C ${SEED_ROOT}/eve-cli --strip-components=1`,
    ]),
  );
  const cliPath = `${sandbox.getWorkingDirectory()}/${SEED_ROOT}/eve-cli/bin/eve.js`;
  await measure(timings, "scaffold subject", () =>
    run(sandbox, "bash", [
      "-lc",
      [
        `rm -rf ${SCAFFOLD_ROOT}`,
        `cd /tmp`,
        `AI_AGENT=benchmark npm_config_user_agent=npm/11 EVE_INIT_PACKAGE_SPEC=${shellQuote(tarballPath)} node ${shellQuote(cliPath)} init ${SCAFFOLD_ROOT.slice("/tmp/".length)}`,
        `rm -rf ${SCAFFOLD_ROOT}/.git`,
        `cp -a ${SCAFFOLD_ROOT}/. ${shellQuote(sandbox.getWorkingDirectory())}/`,
        `rm -rf ${SCAFFOLD_ROOT} ${SEED_ROOT}/eve-cli`,
      ].join(" && "),
    ]),
  );
  if (options.syntheticImessage === true) {
    await measure(timings, "install synthetic iMessage world", async () => {
      await installSyntheticImessageWorld(sandbox);
      await sandbox.writeFiles({
        ".claude/settings.json": JSON.stringify({
          env: { EVE_DEV_OFFICIAL_REGISTRY_URL: SYNTHETIC_REGISTRY_URL },
        }),
      });
    });
  }
  await measure(timings, "install eval dependencies", async () => {
    await run(sandbox, "npm", [
      "install",
      "--save-dev",
      "--package-lock=false",
      "--registry=https://registry.npmjs.org",
      "vitest@4.1.10",
    ]);
  });
  if (options.agentsMd !== true)
    await measure(timings, "remove agent guidance", () => removeScaffoldedAgentGuidance(sandbox));
  await sandbox.writeFiles({
    "__authoring_eval__/setup-timings.json": JSON.stringify(timings),
  });
}

async function installSyntheticImessageWorld(sandbox: Sandbox): Promise<void> {
  const channel = {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: "channel/photon-imessage",
    title: "Photon iMessage",
    description: "Connect an eve agent to iMessage through a deterministic provider setup flow.",
    files: [
      {
        path: "registry/channels/photon-imessage.ts",
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
        docs: "/docs/channels/photon-imessage",
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
    homepage: SYNTHETIC_REGISTRY_URL,
    items: [
      {
        name: "channel/photon-imessage",
        type: "registry:item",
        description: channel.description,
        registry: `${SYNTHETIC_REGISTRY_URL}/registry.json`,
        addCommandArgument: `${SYNTHETIC_REGISTRY_URL}/channel/photon-imessage.json`,
      },
    ],
  };

  await sandbox.writeFiles({
    [`${REGISTRY_ROOT}/registry.json`]: JSON.stringify(catalog),
    [`${REGISTRY_ROOT}/channel/photon-imessage.json`]: JSON.stringify(channel),
  });
  await run(sandbox, "npm", [
    "pkg",
    "set",
    `dependencies.@eve-internal/mock-imessage-setup=file:${SEED_ROOT}/mock-imessage-setup`,
  ]);
  await run(sandbox, "bash", [
    "-lc",
    `nohup python3 -m http.server 4173 --directory ${REGISTRY_ROOT} >__authoring_eval__/registry.log 2>&1 </dev/null &`,
  ]);
}

async function removeScaffoldedAgentGuidance(sandbox: Sandbox): Promise<void> {
  await run(sandbox, "rm", ["-f", "AGENTS.md", "CLAUDE.md"]);
}

interface SetupTiming {
  label: string;
  durationMs: number;
}

async function measure<T>(
  timings: SetupTiming[],
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    const durationMs = Math.round(performance.now() - startedAt);
    timings.push({ label, durationMs });
    console.log(`[authoring-benchmark] setup ${label}: ${durationMs}ms`);
  }
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
