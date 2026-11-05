import { join } from "node:path";

import type { Runtime } from "#channel/types.js";
import { localWorld } from "#execution/world/local-world.js";
import { vercelWorld } from "#execution/world/vercel-world.js";
import { createWorldHost, type WorldHost } from "#execution/world-host/host.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { workflowHost } from "#execution/workflow-host/host.js";
import { startWorkflowToolRun } from "#execution/workflow-host/start-run.js";
import { deriveEveWorldHostQueueNamespace } from "#internal/workflow/queue-namespace.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";

// An agent built to run on a World host (experimental, `EVE_EXPERIMENTAL_WORLD_HOST=1` at
// build): its sessions run only when something arrives for them, kept on the World, instead of
// in Workflow. The server's routes are a deployment's as ever, and:
//   - channel routes, schedule tasks and the schedule consumer start sessions in its runtime;
//   - its own queue route, a function its own queue trigger invokes, runs its activations, in a
//     namespace of their own (`deriveEveWorldHostQueueNamespace`);
//   - Workflow's route is Workflow's still: authored workflow tools run there, as Workflow runs.
//     Their steps report to their sessions through the World host, which wraps Workflow as each
//     function's durable host (`prepareWorldHostRealm`).
// On Vercel the World is the project's; elsewhere (`eve start`) it's the local World in a
// directory, whose queue runs in this process.

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
      queueNamespace: deriveEveWorldHostQueueNamespace(agentName),
      // Authored workflow tools run on Workflow, which this deployment also serves.
      workflow: { host: workflowHost, startRun: startWorkflowToolRun },
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

/**
 * Makes this process's durable host the World host's, before Workflow runs here: a workflow
 * tool's steps report to its session, which is on the World host.
 */
export async function prepareWorldHostRealm(config: NitroArtifactsConfig): Promise<void> {
  await nitroWorldHost(config);
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
