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
import { VercelNetworkPolicyManager } from "./vercel-network-policy-manager.js";

export async function loadHarnessAgentSandboxSession(): Promise<HarnessV1NetworkSandboxSession> {
  const access = loadContext().get(SandboxKey);
  const session = await access?.get();

  if (session === undefined || session === null) {
    throw new Error("Harness-backed agents require an active sandbox.");
  }

  const sandbox = getVercelSandboxForSandboxSession({ session });
  if (sandbox === undefined) {
    throw new Error("Harness-backed agents currently require the Vercel sandbox backend.");
  }

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
      return sandbox.routes.map((route) => route.port);
    },
    getPortEndpoint,
    getPortUrl: async (options) => (await getPortEndpoint(options)).url,
    id: sandbox.name,
    restricted: () => restricted,
    stop: callerOwnedLifecycleNoop,
  };
}
