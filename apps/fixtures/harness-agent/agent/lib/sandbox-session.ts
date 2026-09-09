import { randomUUID } from "node:crypto";

import type { HarnessV1NetworkSandboxSession, HarnessV1PortEndpoint } from "@ai-sdk/harness";
import type { SandboxSession } from "eve/sandbox";

const DEFAULT_WORKING_DIRECTORY = "/workspace";
const HARNESS_ROOT = "/workspace/.eve-harness";

type VercelSandbox = Awaited<
  ReturnType<(typeof import("@vercel/sandbox-drives"))["Sandbox"]["get"]>
>;

export async function adaptHarnessNetworkSandboxSession(input: {
  readonly sandbox: SandboxSession;
}): Promise<HarnessV1NetworkSandboxSession> {
  const vercelSandbox = await resolveVercelSandbox(input.sandbox);
  const ports = resolveHarnessPorts(vercelSandbox);
  const lease = await reserveHarnessPort({
    ports,
    sandbox: input.sandbox,
  });
  let released = false;
  const releasePort = async () => {
    if (released) return;
    released = true;
    await lease.release();
  };
  const session: HarnessV1NetworkSandboxSession = {
    defaultWorkingDirectory: DEFAULT_WORKING_DIRECTORY,
    destroy: releasePort,
    description: "An eve-orchestrated Vercel sandbox used by a HarnessAgent session.",
    getPortEndpoint: async (options: {
      port: number;
      protocol?: "http" | "https" | "ws";
    }): Promise<HarnessV1PortEndpoint> => {
      if (options.port !== lease.port) {
        throw new Error(`Port ${options.port} is not leased to this HarnessAgent session.`);
      }
      const url = new URL(vercelSandbox.domain(options.port));
      const protocol = options.protocol ?? "https";
      const isSecure = url.protocol === "https:";
      url.protocol =
        protocol === "ws"
          ? isSecure
            ? "wss:"
            : "ws:"
          : protocol === "http"
            ? isSecure
              ? "https:"
              : "http:"
            : "https:";
      return { url: url.toString() };
    },
    getPortUrl: async (options: {
      port: number;
      protocol?: "http" | "https" | "ws";
    }): Promise<string> => {
      return (await session.getPortEndpoint(options)).url;
    },
    id: input.sandbox.id,
    ports: [lease.port],
    readBinaryFile: input.sandbox.readBinaryFile,
    readFile: input.sandbox.readFile,
    readTextFile: input.sandbox.readTextFile,
    restricted: () => session,
    run: input.sandbox.run,
    spawn: input.sandbox.spawn,
    stop: async () => {},
    writeBinaryFile: input.sandbox.writeBinaryFile,
    writeFile: input.sandbox.writeFile,
    writeTextFile: input.sandbox.writeTextFile,
  };

  return session;
}

async function resolveVercelSandbox(sandbox: SandboxSession): Promise<VercelSandbox> {
  const { Sandbox } = await import("@vercel/sandbox-drives");
  try {
    return await Sandbox.get({ name: sandbox.id, resume: false });
  } catch (error) {
    throw new Error("HarnessAgent tools require the current eve sandbox to be a Vercel Sandbox.", {
      cause: error,
    });
  }
}

function resolveHarnessPorts(vercelSandbox: VercelSandbox): readonly number[] {
  const ports = vercelSandbox.routes.map((route) => route.port);
  if (ports.length === 0) {
    throw new Error(
      "HarnessAgent tools require an exposed Vercel Sandbox port. Configure the sandbox with a ports array.",
    );
  }
  return ports;
}

async function reserveHarnessPort(input: {
  readonly ports: readonly number[];
  readonly sandbox: Pick<SandboxSession, "run">;
}): Promise<{ readonly port: number; readonly release: () => Promise<void> }> {
  const owner = randomUUID();
  const result = await input.sandbox.run({
    command:
      `root=${HARNESS_ROOT}/ports; mkdir -p "$root"; ` +
      "for port in $EVE_HARNESS_PORTS; do " +
      `node -e 'const net=require("node:net"); const server=net.createServer(); ` +
      `server.unref(); server.once("error",()=>process.exit(1)); ` +
      `server.listen(Number(process.argv[1]),"0.0.0.0",()=>server.close(()=>process.exit(0)))' "$port" || continue; ` +
      `if mkdir "$root/$port" 2>/dev/null; then ` +
      `printf '%s' "$EVE_HARNESS_PORT_OWNER" > "$root/$port/owner"; ` +
      `printf '%s' "$port"; exit 0; ` +
      "fi; done; exit 75",
    env: {
      EVE_HARNESS_PORT_OWNER: owner,
      EVE_HARNESS_PORTS: input.ports.join(" "),
    },
  });
  const port = Number(result.stdout.trim());
  if (result.exitCode !== 0 || !input.ports.includes(port)) {
    throw new Error("No exposed Vercel Sandbox port is available for this HarnessAgent session.");
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
