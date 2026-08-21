import { randomUUID } from "node:crypto";

import type { HarnessBridgeSettings } from "#execution/harness-agent/adapter.js";
import { harnessUsesBridge } from "#execution/harness-agent/adapter.js";
import type { HarnessAgentHarness } from "#execution/harness-agent/types.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const HARNESS_ROOT = "/tmp/eve-harness";

type HarnessSandboxSession = SandboxSession & {
  readonly description: string;
  readonly defaultWorkingDirectory: string;
};

export interface HarnessSandboxHandle {
  readonly bridge?: HarnessBridgeSettings;
  readonly session: HarnessSandboxSession;
  dispose(): Promise<void>;
}

export async function createHarnessSandboxHandle(input: {
  readonly sandbox: SandboxSession;
  readonly harness: HarnessAgentHarness;
}): Promise<HarnessSandboxHandle> {
  const bridgeLease = harnessUsesBridge(input.harness)
    ? await resolveHarnessBridgeSettings({ harness: input.harness, sandbox: input.sandbox })
    : undefined;
  try {
    await prepareHarnessWorkspace(input.sandbox);
  } catch (error) {
    await bridgeLease?.release();
    throw error;
  }

  return {
    bridge: bridgeLease?.settings,
    dispose: async () => await bridgeLease?.release(),
    session: adaptSandboxSession(input.sandbox),
  };
}

function adaptSandboxSession(sandbox: SandboxSession): HarnessSandboxSession {
  return {
    defaultWorkingDirectory: HARNESS_ROOT,
    description: "An eve sandbox with the agent workspace mounted at /workspace.",
    readBinaryFile: sandbox.readBinaryFile,
    readFile: sandbox.readFile,
    readTextFile: sandbox.readTextFile,
    run: sandbox.run,
    spawn: sandbox.spawn,
    writeBinaryFile: sandbox.writeBinaryFile,
    writeFile: sandbox.writeFile,
    writeTextFile: sandbox.writeTextFile,
    id: sandbox.id,
    removePath: sandbox.removePath,
    resolvePath: sandbox.resolvePath,
    setNetworkPolicy: sandbox.setNetworkPolicy,
  };
}

async function resolveHarnessBridgeSettings(input: {
  readonly harness: HarnessAgentHarness;
  readonly sandbox: SandboxSession;
}): Promise<{ readonly settings: HarnessBridgeSettings; release(): Promise<void> }> {
  const { Sandbox } = await import("#compiled/@vercel/sandbox/index.js");
  let vercelSandbox: Awaited<ReturnType<typeof Sandbox.get>>;
  try {
    vercelSandbox = await Sandbox.get({ name: input.sandbox.id, resume: false });
  } catch (error) {
    throw new Error(
      `The ${input.harness} harness requires the current eve sandbox to be a Vercel Sandbox with an exposed port.`,
      { cause: error },
    );
  }

  const ports = vercelSandbox.routes.map((route) => route.port);
  if (ports.length === 0) {
    throw new Error(
      `The ${input.harness} harness requires an exposed Vercel Sandbox port. Configure the sandbox with a ports array.`,
    );
  }
  const lease = await reserveHarnessPort({ ports, sandbox: input.sandbox });
  const url = new URL(vercelSandbox.domain(lease.port));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    release: lease.release,
    settings: { port: lease.port, portEndpoint: { url: url.toString() } },
  };
}

async function reserveHarnessPort(input: {
  readonly ports: readonly number[];
  readonly sandbox: SandboxSession;
}): Promise<{ readonly port: number; release(): Promise<void> }> {
  const owner = randomUUID();
  const result = await input.sandbox.run({
    command:
      `root=${HARNESS_ROOT}/ports; mkdir -p "$root"; ` +
      `for port in $EVE_HARNESS_PORTS; do ` +
      `if mkdir "$root/$port" 2>/dev/null; then ` +
      `printf '%s' "$EVE_HARNESS_PORT_OWNER" > "$root/$port/owner"; ` +
      `printf '%s' "$port"; exit 0; ` +
      `fi; done; exit 75`,
    env: {
      EVE_HARNESS_PORT_OWNER: owner,
      EVE_HARNESS_PORTS: input.ports.join(" "),
    },
  });
  const port = Number(result.stdout.trim());
  if (result.exitCode !== 0 || !input.ports.includes(port)) {
    throw new Error(
      "No exposed Vercel Sandbox port is available for this HarnessAgent invocation.",
    );
  }

  return {
    port,
    async release() {
      const release = await input.sandbox.run({
        command:
          `root=${HARNESS_ROOT}/ports/${port}; ` +
          `owner=$(cat "$root/owner" 2>/dev/null); ` +
          `if [ "$owner" = "$EVE_HARNESS_PORT_OWNER" ]; then ` +
          `rm -f "$root/owner" && rmdir "$root"; fi`,
        env: { EVE_HARNESS_PORT_OWNER: owner },
      });
      if (release.exitCode !== 0) {
        throw new Error(
          `Failed to release HarnessAgent sandbox port ${port}: ${release.stderr || release.stdout}`,
        );
      }
    },
  };
}

async function prepareHarnessWorkspace(sandbox: SandboxSession): Promise<void> {
  const result = await sandbox.run({
    command:
      `mkdir -p ${HARNESS_ROOT} && ` +
      `if [ ! -e ${HARNESS_ROOT}/workspace ]; then ln -s /workspace ${HARNESS_ROOT}/workspace; fi && ` +
      `test "$(readlink -f ${HARNESS_ROOT}/workspace)" = /workspace`,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to prepare the harness workspace inside the eve sandbox: ${result.stderr || result.stdout}`,
    );
  }
}
