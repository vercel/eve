import { randomUUID } from "node:crypto";

import type { HarnessBridgeSettings } from "#execution/harness-agent/adapter.js";
import { harnessUsesBridge } from "#execution/harness-agent/adapter.js";
import type { HarnessAgentHarness } from "#execution/harness-agent/types.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const HARNESS_ROOT = "/workspace/.eve-harness";
const HARNESS_TEMP = `${HARNESS_ROOT}/tmp`;

type VercelSandbox = Awaited<
  ReturnType<(typeof import("#compiled/@vercel/sandbox/index.js"))["Sandbox"]["get"]>
>;

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
  let bridge: HarnessBridgeSettings | undefined;
  let dispose = async () => {};
  const session = adaptSandboxSession(input.sandbox);
  if (harnessUsesBridge(input.harness)) {
    const vercelSandbox = await resolveVercelSandbox({
      harness: input.harness,
      sandbox: input.sandbox,
    });
    const ports = resolveHarnessPorts({
      harness: input.harness,
      vercelSandbox,
    });
    await prepareHarnessWorkspace(session);
    const bridgeLease = await reserveHarnessBridge({
      ports,
      session,
      vercelSandbox,
    });
    bridge = bridgeLease.settings;
    dispose = bridgeLease.release;
  } else {
    await prepareHarnessWorkspace(session);
  }

  return {
    bridge,
    dispose,
    session,
  };
}

function adaptSandboxSession(sandbox: SandboxSession): HarnessSandboxSession {
  return {
    defaultWorkingDirectory: HARNESS_ROOT,
    description: "An eve sandbox with the agent workspace mounted at /workspace.",
    readBinaryFile: sandbox.readBinaryFile,
    readFile: sandbox.readFile,
    readTextFile: sandbox.readTextFile,
    async run(options) {
      return await sandbox.run({
        ...options,
        env: { ...options.env, TMPDIR: HARNESS_TEMP },
      });
    },
    async spawn(options) {
      return await sandbox.spawn({
        ...options,
        env: { ...options.env, TMPDIR: HARNESS_TEMP },
      });
    },
    writeBinaryFile: sandbox.writeBinaryFile,
    writeFile: sandbox.writeFile,
    writeTextFile: sandbox.writeTextFile,
    id: sandbox.id,
    removePath: sandbox.removePath,
    resolvePath: sandbox.resolvePath,
    setNetworkPolicy: sandbox.setNetworkPolicy,
  };
}

async function resolveVercelSandbox(input: {
  readonly harness: HarnessAgentHarness;
  readonly sandbox: SandboxSession;
}): Promise<VercelSandbox> {
  const { Sandbox } = await import("#compiled/@vercel/sandbox/index.js");
  try {
    return await Sandbox.get({ name: input.sandbox.id, resume: false });
  } catch (error) {
    throw new Error(
      `The ${input.harness} harness requires the current eve sandbox to be a Vercel Sandbox with an exposed port.`,
      { cause: error },
    );
  }
}

function resolveHarnessPorts(input: {
  readonly harness: HarnessAgentHarness;
  readonly vercelSandbox: VercelSandbox;
}): readonly number[] {
  const ports = input.vercelSandbox.routes.map((route) => route.port);
  if (ports.length === 0) {
    throw new Error(
      `The ${input.harness} harness requires an exposed Vercel Sandbox port. Configure the sandbox with a ports array.`,
    );
  }
  return ports;
}

async function reserveHarnessBridge(input: {
  readonly ports: readonly number[];
  readonly session: SandboxSession;
  readonly vercelSandbox: VercelSandbox;
}): Promise<{ readonly settings: HarnessBridgeSettings; release(): Promise<void> }> {
  const lease = await reserveHarnessPort({ ports: input.ports, sandbox: input.session });
  const port = lease.port;
  const url = new URL(input.vercelSandbox.domain(port));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    release: lease.release,
    settings: { port, portEndpoint: { url: url.toString() } },
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
      `node -e 'const net=require("node:net"); const server=net.createServer(); ` +
      `server.unref(); server.once("error",()=>process.exit(1)); ` +
      `server.listen(Number(process.argv[1]),"0.0.0.0",()=>server.close(()=>process.exit(0)))' "$port" || continue; ` +
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
      `mkdir -p ${HARNESS_TEMP} && ` +
      `if [ ! -e ${HARNESS_ROOT}/workspace ]; then ln -s /workspace ${HARNESS_ROOT}/workspace; fi && ` +
      `test "$(readlink -f ${HARNESS_ROOT}/workspace)" = /workspace`,
    workingDirectory: "/workspace",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to prepare the harness workspace inside the eve sandbox: ${result.stderr || result.stdout}`,
    );
  }
}
