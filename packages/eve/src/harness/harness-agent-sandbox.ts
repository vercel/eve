import { createHash } from "node:crypto";
import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1NetworkSandboxSession,
  type HarnessV1PortEndpoint,
} from "@ai-sdk/harness";
import type { Experimental_SandboxSession } from "ai";

import { loadContext } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { getVercelSandboxForSandboxSession } from "#execution/sandbox/bindings/vercel-session-registry.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { VercelNetworkPolicyManager } from "./vercel-network-policy-manager.js";

export async function loadHarnessAgentSandboxSession(input: {
  readonly sessionId: string;
}): Promise<HarnessV1NetworkSandboxSession> {
  const access = loadContext().get(SandboxKey);
  const session = await access?.get();

  if (session === undefined || session === null) {
    throw new Error("Harness-backed agents require an active sandbox.");
  }

  const sandbox = getVercelSandboxForSandboxSession({ session });
  if (sandbox === undefined) {
    throw new Error("Harness-backed agents currently require the Vercel sandbox backend.");
  }
  const exposedPorts = sandbox.routes.map((route) => route.port);
  const leasedPort = await leaseHarnessPort({
    ports: exposedPorts,
    session,
    sessionId: input.sessionId,
  });

  const networkPolicyManager = new VercelNetworkPolicyManager({ sandbox });

  const restricted: Experimental_SandboxSession = {
    description: [
      `Vercel Sandbox (name: ${sandbox.name}).`,
      `The default working directory is ${WORKSPACE_ROOT}.`,
      "Filesystem changes persist for the lifetime of the sandbox.",
    ].join("\n"),
    readBinaryFile: session.readBinaryFile,
    readFile: session.readFile,
    readTextFile: session.readTextFile,
    run: session.run,
    spawn: session.spawn,
    writeBinaryFile: session.writeBinaryFile,
    writeFile: session.writeFile,
    writeTextFile: session.writeTextFile,
  };

  const getPortEndpoint = async (options: {
    readonly port: number;
    readonly protocol?: "http" | "https" | "ws";
  }): Promise<HarnessV1PortEndpoint> => {
    const ports = sandbox.routes.map((route) => route.port);
    if (!ports.includes(options.port)) {
      throw new HarnessCapabilityUnsupportedError({
        harnessId: "vercel-sandbox",
        message:
          `Port ${options.port} is not exposed on this sandbox. ` +
          `Exposed ports: [${ports.join(", ")}].`,
      });
    }

    const protocol = options.protocol ?? "https";
    const url = new URL(sandbox.domain(options.port));
    const secure = url.protocol === "https:";
    switch (protocol) {
      case "http":
        url.protocol = secure ? "https:" : "http:";
        break;
      case "https":
        url.protocol = "https:";
        break;
      case "ws":
        url.protocol = secure ? "wss:" : "ws:";
        break;
    }
    return { url: url.toString() };
  };

  const callerOwnedLifecycleNoop = async (): Promise<void> => {};

  return {
    ...restricted,
    addRequestTransformations: (transformations) =>
      networkPolicyManager.addRequestTransformations(transformations),
    defaultWorkingDirectory: WORKSPACE_ROOT,
    destroy: callerOwnedLifecycleNoop,
    get ports() {
      return [
        leasedPort,
        ...sandbox.routes.map((route) => route.port).filter((port) => port !== leasedPort),
      ];
    },
    getPortEndpoint,
    getPortUrl: async (options) => (await getPortEndpoint(options)).url,
    id: sandbox.name,
    restricted: () => restricted,
    stop: callerOwnedLifecycleNoop,
  };
}

async function leaseHarnessPort(input: {
  readonly ports: readonly number[];
  readonly session: SandboxSession;
  readonly sessionId: string;
}): Promise<number> {
  if (input.ports.length === 0) {
    throw new Error("Harness-backed agents require at least one exposed Vercel sandbox port.");
  }
  const sessionKey = createHash("sha256").update(input.sessionId).digest("hex");
  const ports = input.ports.join(" ");
  /*
   * The sandbox filesystem is shared across workflow steps and delegated agents.
   * A session directory serializes claims for one eve session; mkdir on a port
   * directory serializes claims across different sessions. Keep both directories
   * until the sandbox ends so a detached session can reconnect to its own port.
   */
  const command = `
root=/tmp/eve-harness-port-leases
session="$root/session-${sessionKey}"
mkdir -p "$root" || exit 2
if mkdir "$session" 2>/dev/null; then
  for port in ${ports}; do
    if mkdir "$root/port-$port" 2>/dev/null; then
      printf '%s' "$port" > "$session/port" || exit 2
      printf '%s' "$port"
      exit 0
    fi
  done
  rmdir "$session"
  exit 3
fi
attempt=0
while [ "$attempt" -lt 30 ]; do
  if [ -f "$session/port" ]; then
    port=$(cat "$session/port")
    case " ${ports} " in
      *" $port "*) printf '%s' "$port"; exit 0 ;;
    esac
    exit 4
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
exit 2`;
  const result = await input.session.run({ command });
  const port = Number(result.stdout.trim());
  if (result.exitCode !== 0 || !input.ports.includes(port)) {
    throw new Error(
      result.exitCode === 3
        ? "No free exposed Vercel sandbox port is available for this HarnessAgent session. Expose another port in the sandbox configuration."
        : "Could not reserve an exposed Vercel sandbox port for this HarnessAgent session.",
    );
  }
  return port;
}
