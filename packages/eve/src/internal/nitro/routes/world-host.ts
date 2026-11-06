import { join } from "node:path";

import type { Runtime } from "#channel/types.js";
import { localWorld } from "#execution/world/local-world.js";
import { vercelWorld } from "#execution/world/vercel-world.js";
import { createWorldHost, type WorldHost } from "#execution/world-host/host.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";
import { deriveEveWorkflowQueueNamespace } from "#internal/workflow/queue-namespace.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";

// An agent built to run on a World host (experimental, `EVE_EXPERIMENTAL_WORLD_HOST=1` at
// build): its sessions run only when something arrives for them, kept on the World, instead of
// in Workflow. The server's routes are a deployment's as ever; each that would reach Workflow
// reaches the agent's World host instead:
//   - channel routes, schedule tasks and the schedule consumer start sessions in its runtime;
//   - the queue route, the function Vercel's queue trigger invokes, runs its activations, which
//     travel in the agent's own queue namespace, the one that trigger names.
// On Vercel the World is the project's; elsewhere (`eve start`) it's the local World in a
// directory, whose queue runs in this process.

/** Set at build: the agent's sessions run on a World host. */
export const EVE_WORLD_HOST_ENV = "EVE_EXPERIMENTAL_WORLD_HOST";

/** Whether the server was built to run its agent on a World host. */
export function usesWorldHost(config: NitroArtifactsConfig): boolean {
  return config.kind === "production" && config.host === "world";
}

interface NitroWorldHost {
  readonly host: WorldHost;
  readonly agentName: string;
}

let held: Promise<NitroWorldHost> | undefined;

/** This server's World host, made on first use. */
export function nitroWorldHost(config: NitroArtifactsConfig): Promise<NitroWorldHost> {
  held ??= (async () => {
    const source = resolveNitroCompiledArtifactsSource(config);
    const manifest = await loadCompiledManifest({ compiledArtifactsSource: source });
    const agentName = manifest.config.name;
    const onVercel = process.env.VERCEL === "1";
    const host = createWorldHost({
      compiledAgents: { [agentName]: source },
      queueNamespace: deriveEveWorkflowQueueNamespace(agentName),
      world: onVercel
        ? vercelWorld()
        : localWorld({
            dataDir: process.env.EVE_WORLD_DATA_DIR ?? join(process.cwd(), ".eve", "world"),
          }),
      // Where sign-in links send the provider back to: as for a session on Workflow, the
      // deployment's URL, the configured local origin, or this server.
      callbackBaseUrl: resolveWorkflowCallbackBaseUrl(
        process.env.VERCEL_URL !== undefined
          ? `https://${process.env.VERCEL_URL}`
          : `http://localhost:${process.env.PORT ?? "3000"}`,
      ),
    });
    // Off Vercel, the World's queue delivers in this process.
    if (!onVercel) await host.serve();
    return { agentName, host };
  })();
  held.catch(() => {
    held = undefined;
  });
  return held;
}

/** The runtime sessions start in: the World host's for the agent. */
export async function worldHostRuntime(config: NitroArtifactsConfig): Promise<Runtime> {
  const { agentName, host } = await nitroWorldHost(config);
  return host.runtime(agentName);
}

/** The queue route: one activation of one session. */
export async function handleWorldHostQueue(
  config: NitroArtifactsConfig,
  request: Request,
): Promise<Response> {
  return await (await nitroWorldHost(config)).host.queueHandler()(request);
}
